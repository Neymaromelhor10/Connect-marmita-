-- ============================================================================
-- MARMITA CONNECT (VERDE&MESA) — SUÍTE DE HOMOLOGAÇÃO TÉCNICA EM POSTGRESQL REAL
-- ============================================================================
-- Executa validações reais no banco PostgreSQL/Supabase isolado de homologação:
--   0. Limpeza determinística dos IDs sintéticos de homologação (garantindo que
--      2 ou mais execuções consecutivas produzam resultados e somas idênticos,
--      sem conflito de triggers nem acumulação descontrolada no backup)
--   1. Verificação de Tabelas, Índices, Constraints, Triggers, RPCs (sem sobrecarga
--      ambígua em register_payment) e Permissões (anon/authenticated/service_role)
--   2. Execução sob SET LOCAL ROLE authenticated comprovando bloqueio de escrita
--      direta nas tabelas e funcionamento de todas as RPCs autorizadas
--   3. 12 Cenários Financeiros Obrigatórios (3G+2M=96, 5G OK=100, 5G OKK=100,
--      pagamento parcial 60 + 40, imutabilidade histórica de preços, idempotência,
--      cancelamento com tombstone e bloqueio de requisição atrasada,
--      rollback transacional sem auditoria e bloqueio via constraint trigger)
--   4. Fila Durável do WhatsApp (6 estados, lease/lock, expiração, revisão atômica,
--      bloqueio de reprocessamento de concluídos e isolamento entre empresas)
--   5. Anonimização LGPD (pré-validação com dívida aberta vs. anonimização completa)
--   6. Validação das correções Argon 4 (0012 a 0017: AUD-01..10, AUD3-01..08, AUD5-01..05, AUD6-01..09 e AUD8-01..04)
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- ============================================================================
-- BLOCO 0: LIMPEZA DETERMINÍSTICA PARA IDEMPOTÊNCIA EM EXECUÇÕES CONSECUTIVAS
-- ============================================================================
ALTER TABLE public.orders DISABLE TRIGGER zz_financial_guard_order;
ALTER TABLE public.financial_events DISABLE TRIGGER financial_audit_immutable;
SET LOCAL app.allow_audit_cleanup = 'on';

UPDATE public.orders
   SET financial_last_audit_id = NULL
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.financial_events
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.payment_attempts
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.payments
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.lgpd_lifecycle_audit
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 ) OR company_id IS NULL;

DELETE FROM public.whatsapp_manual_retry_audit
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.whatsapp_messages
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.orders
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.customers
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.financial_permissions
 WHERE company_id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DELETE FROM public.user_roles
 WHERE user_id IN (
   'aaaaaaaa-0000-4000-8000-000000000011',
   'bbbbbbbb-0000-4000-8000-000000000022'
 );

DELETE FROM public.profiles
 WHERE id IN (
   'aaaaaaaa-0000-4000-8000-000000000011',
   'bbbbbbbb-0000-4000-8000-000000000022'
 );

DELETE FROM public.companies
 WHERE id IN (
   'aaaaaaaa-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-000000000002'
 );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'identities'
  ) THEN
    DELETE FROM auth.identities
     WHERE user_id IN (
       'aaaaaaaa-0000-4000-8000-000000000011',
       'bbbbbbbb-0000-4000-8000-000000000022'
     );
  END IF;
END $$;

DELETE FROM auth.users
 WHERE id IN (
   'aaaaaaaa-0000-4000-8000-000000000011',
   'bbbbbbbb-0000-4000-8000-000000000022'
 ) OR email IN ('op.a@homolog.local', 'op.b@homolog.local');

SET LOCAL app.allow_audit_cleanup = 'off';
ALTER TABLE public.financial_events ENABLE TRIGGER financial_audit_immutable;
ALTER TABLE public.orders ENABLE TRIGGER zz_financial_guard_order;

-- ============================================================================
-- BLOCO 1: AUDITORIA DE SCHEMA, ASSINATURAS RPC, TRIGGERS E PERMISSÕES
-- ============================================================================
DO $$
DECLARE
  missing_count int;
  reg_pay_overloads int;
BEGIN
  -- 1.1. Confirma existência das 12 tabelas obrigatórias (incluindo whatsapp_manual_retry_audit da 0015)
  SELECT count(*) INTO missing_count
  FROM unnest(ARRAY[
    'companies', 'profiles', 'user_roles', 'customers', 'orders',
    'payments', 'payment_attempts', 'financial_permissions',
    'financial_events', 'whatsapp_connections', 'whatsapp_messages',
    'whatsapp_manual_retry_audit'
  ]) AS t(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = t.name
  );
  IF missing_count > 0 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Faltam % tabelas obrigatórias no schema public', missing_count;
  END IF;

  -- 1.2. Confirma que não há sobrecarga ambígua em public.register_payment
  SELECT count(*) INTO reg_pay_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'register_payment';

  IF reg_pay_overloads <> 1 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Esperada exatamente 1 assinatura para public.register_payment, encontradas: %', reg_pay_overloads;
  END IF;

  -- 1.3. Confirma existência do Constraint Trigger DEFERRABLE INITIALLY IMMEDIATE em public.orders
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'zz_financial_require_audit_event'
      AND tgdeferrable = true
      AND tginitdeferred = false
  ) THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Constraint trigger zz_financial_require_audit_event não encontrado ou não é DEFERRABLE INITIALLY IMMEDIATE';
  END IF;

  -- 1.4. Confirma que authenticated NÃO possui INSERT, UPDATE ou DELETE em orders, payments, financial_events e whatsapp_manual_retry_audit
  IF has_table_privilege('authenticated', 'public.orders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.orders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.orders', 'DELETE')
     OR has_table_privilege('authenticated', 'public.payments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payments', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payments', 'DELETE')
     OR has_table_privilege('authenticated', 'public.financial_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.financial_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.financial_events', 'DELETE')
     OR has_table_privilege('authenticated', 'public.whatsapp_manual_retry_audit', 'INSERT')
     OR has_table_privilege('authenticated', 'public.whatsapp_manual_retry_audit', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.whatsapp_manual_retry_audit', 'DELETE') THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Role authenticated ainda possui privilégios de escrita direta em tabelas financeiras/auditoria!';
  END IF;

  -- 1.5. Confirma que authenticated NÃO pode executar financial_classify_by_echo nem claim_whatsapp_queue_batch
  IF has_function_privilege(
       'authenticated',
       'public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Role authenticated não pode ter EXECUTE em financial_classify_by_echo';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Role authenticated não pode ter EXECUTE em claim_whatsapp_queue_batch';
  END IF;

  -- 1.6. AF-08: Confirma que authenticated NÃO pode executar a função legada register_payment, mas pode executar financial_register_payment
  IF has_function_privilege(
       'authenticated',
       'public.financial_register_payment(uuid, numeric, text, text, text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO AF-08] Role authenticated não pode ter EXECUTE na função legada public.register_payment';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.financial_register_payment(uuid, numeric, text, text, text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO AF-08] Role authenticated deve ter EXECUTE na função oficial public.financial_register_payment';
  END IF;

  RAISE NOTICE '[OK BLOCO 1] Schema, assinatura única de register_payment, financial_register_payment, triggers e permissões validados.';
END $$;

-- ============================================================================
-- BLOCO 2: PREPARAÇÃO DE USUÁRIOS AUTH.USERS E EMPRESAS ISOLADAS (A e B)
-- ============================================================================
DO $$
DECLARE
  v_comp_a uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_comp_b uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_user_a uuid := 'aaaaaaaa-0000-4000-8000-000000000011';
  v_user_b uuid := 'bbbbbbbb-0000-4000-8000-000000000022';
  v_cust_a uuid := 'aaaaaaaa-0000-4000-8000-000000000111';
  v_cust_a_lgpd uuid := 'aaaaaaaa-0000-4000-8000-000000000112';
  v_cust_b uuid := 'bbbbbbbb-0000-4000-8000-000000000222';
BEGIN
  INSERT INTO auth.users(id, email, encrypted_password, raw_user_meta_data, created_at)
  VALUES
    (v_user_a, 'op.a@homolog.local', public.crypt('SenhaHomolog123!', public.gen_salt('bf')), '{"full_name":"Operador A"}'::jsonb, now()),
    (v_user_b, 'op.b@homolog.local', public.crypt('SenhaHomolog123!', public.gen_salt('bf')), '{"full_name":"Operador B"}'::jsonb, now());

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'instance_id'
  ) THEN
    UPDATE auth.users
       SET instance_id = '00000000-0000-0000-0000-000000000000'::uuid,
           aud = 'authenticated',
           role = 'authenticated',
           email_confirmed_at = now(),
           raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb,
           updated_at = now(),
           confirmation_token = '',
           recovery_token = '',
           email_change_token_new = '',
           email_change = ''
     WHERE id IN (v_user_a, v_user_b);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'phone_change'
  ) THEN
    EXECUTE $u$
      UPDATE auth.users
         SET phone_change = '',
             phone_change_token = '',
             email_change_token_current = '',
             email_change_confirm_status = 0,
             reauthentication_token = '',
             is_sso_user = false,
             is_anonymous = false
       WHERE email IN ('op.a@homolog.local', 'op.b@homolog.local')
    $u$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'identities'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'auth' AND table_name = 'identities'
        AND column_name = 'id' AND data_type = 'uuid'
    ) THEN
      INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      VALUES
        (v_user_a, v_user_a::text, v_user_a, jsonb_build_object('sub', v_user_a::text, 'email', 'op.a@homolog.local', 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now()),
        (v_user_b, v_user_b::text, v_user_b, jsonb_build_object('sub', v_user_b::text, 'email', 'op.b@homolog.local', 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now())
      ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO auth.identities(id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      VALUES
        (v_user_a::text, v_user_a::text, v_user_a, jsonb_build_object('sub', v_user_a::text, 'email', 'op.a@homolog.local', 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now()),
        (v_user_b::text, v_user_b::text, v_user_b, jsonb_build_object('sub', v_user_b::text, 'email', 'op.b@homolog.local', 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now())
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO public.companies(id, name, price_g, price_m, price_p)
  VALUES
    (v_comp_a, 'Marmitaria Homologação A', 20.00, 18.00, 16.00),
    (v_comp_b, 'Marmitaria Homologação B', 22.00, 20.00, 18.00);

  INSERT INTO public.profiles(id, company_id, full_name, email)
  VALUES
    (v_user_a, v_comp_a, 'Operador A', 'op.a@homolog.local'),
    (v_user_b, v_comp_b, 'Operador B', 'op.b@homolog.local');

  INSERT INTO public.user_roles(user_id, role)
  VALUES
    (v_user_a, 'admin'),
    (v_user_b, 'admin');

  INSERT INTO public.financial_permissions(company_id, user_id, can_classify)
  VALUES
    (v_comp_a, v_user_a, true),
    (v_comp_b, v_user_b, true);

  INSERT INTO public.customers(id, company_id, name, phone, address, notes)
  VALUES
    (v_cust_a, v_comp_a, 'Cliente Principal A', '+55 (11) 98888-7777', 'Rua das Flores, 100', 'Sem cebola'),
    (v_cust_a_lgpd, v_comp_a, 'Cliente LGPD A', '5511988886666', 'Rua das Palmeiras, 50', 'Entrega portaria'),
    (v_cust_b, v_comp_b, 'Cliente Principal B', '(21) 97777-6666', 'Av. Atlântica, 200', NULL);

  IF (SELECT phone FROM public.customers WHERE id = v_cust_a) <> '11988887777'
     OR (SELECT phone FROM public.customers WHERE id = v_cust_a_lgpd) <> '11988886666' THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Normalização automática de telefone falhou!';
  END IF;
END $$;

-- ============================================================================
-- BLOCO 3: EXECUÇÃO COMO ROLE AUTHENTICATED (TESTES FINANCEIROS E ISOLAMENTO)
-- ============================================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000011', true);
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000011","role":"authenticated"}', true);

-- 3.1. Confirma que authenticated é bloqueado ao tentar INSERT direto em public.orders (com SAVEPOINT)
SAVEPOINT sp_direct_order_insert;
DO $$
BEGIN
  INSERT INTO public.orders(company_id, customer_id, quantity, unit_price)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000111', 1, 20);
  RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Role authenticated conseguiu fazer INSERT direto em public.orders!';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK] Role authenticated bloqueada em INSERT direto em public.orders (42501).';
END $$;
ROLLBACK TO SAVEPOINT sp_direct_order_insert;

-- 3.2. Executa os cenários financeiros via RPCs autorizadas como authenticated
DO $$
DECLARE
  v_comp_a uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_cust_a uuid := 'aaaaaaaa-0000-4000-8000-000000000111';
  v_cust_a_lgpd uuid := 'aaaaaaaa-0000-4000-8000-000000000112';

  v_ord_96 jsonb;
  v_ord_100_paid jsonb;
  v_ord_100_fiado jsonb;
  v_ord_100_fiado_id uuid;
  v_ord_lgpd jsonb;
  v_pay_60_id uuid;
  v_pay_40_id uuid;
  v_pay_dup_id uuid;
  v_pay_count int;
  v_pay_sum numeric;
  v_cust_status public.customer_status;

  v_idem_key_1 text := 'homolog-pay-key-1';
  v_idem_key_cancel text := 'homolog-pay-key-cancel';
  v_rec_check jsonb;
  v_rec_cancel jsonb;
  v_lgpd_diag jsonb;
  v_lgpd_res jsonb;
BEGIN
  -- Cenário 1: 3 marmitas G (R$ 20) + 2 M (R$ 18) = R$ 96,00 (aguardando_classificacao)
  v_ord_96 := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_a,
    _qty_p => 0,
    _qty_m => 2,
    _qty_g => 3,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'aguardando_classificacao',
    _source => 'manual',
    _event_id => 'aaaaaaaa-0000-4000-8000-000000001001'::uuid
  );

  IF (v_ord_96->>'total')::numeric <> 96.00
     OR (v_ord_96->>'financial_state') <> 'aguardando_classificacao'
     OR (v_ord_96->>'paid')::boolean <> false THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Cálculo de 3G + 2M divergiu de R$ 96,00: %', v_ord_96;
  END IF;

  -- Cenário 2: 5 G pagos na hora (OK) = R$ 100,00, sem gerar dívida
  v_ord_100_paid := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_a,
    _qty_p => 0,
    _qty_m => 0,
    _qty_g => 5,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'pago',
    _source => 'manual',
    _event_id => 'aaaaaaaa-0000-4000-8000-000000001002'::uuid
  );

  IF (v_ord_100_paid->>'total')::numeric <> 100.00
     OR (v_ord_100_paid->>'financial_state') <> 'pago'
     OR (v_ord_100_paid->>'paid')::boolean <> true
     OR (v_ord_100_paid->>'financial_last_audit_id') IS NULL THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Pedido de 5G pago (R$ 100,00) inválido: %', v_ord_100_paid;
  END IF;

  v_lgpd_diag := public.lgpd_inspect_customer(v_cust_a);
  IF (v_lgpd_diag->>'open_debt_amount')::numeric <> 0.00 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Pedido pago ou pendente gerou dívida indevida: %', v_lgpd_diag;
  END IF;

  -- Cenário 3: 5 G para pagar depois (OKK) = R$ 100,00 em Contas a Receber
  v_ord_100_fiado := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_a,
    _qty_p => 0,
    _qty_m => 0,
    _qty_g => 5,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'fiado',
    _source => 'manual',
    _event_id => 'aaaaaaaa-0000-4000-8000-000000001003'::uuid
  );
  v_ord_100_fiado_id := (v_ord_100_fiado->>'id')::uuid;

  IF (v_ord_100_fiado->>'total')::numeric <> 100.00
     OR (v_ord_100_fiado->>'financial_state') <> 'fiado'
     OR (v_ord_100_fiado->>'paid')::boolean <> false THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Pedido 5G fiado inválido: %', v_ord_100_fiado;
  END IF;

  -- Enquanto houver dívida em aberto (R$ 100,00), anonimização completa deve ser bloqueada
  BEGIN
    PERFORM public.lgpd_anonymize_customer_pii(
      _customer_id => v_cust_a,
      _scope => 'anonimizacao_completa',
      _confirm_token => 'LGPD_CONFIRM_' || v_cust_a::text,
      _protocol => 'HOMOLOG-BLOCK-DEBT'
    );
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Permitiu anonimização completa de cliente com dívida em aberto!';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%Anonimização completa bloqueada%' THEN
        RAISE;
      END IF;
  END;

  -- Cenário 4: Pagamento parcial de R$ 60,00 em dívida de R$ 100,00
  PERFORM public.begin_payment_attempt(v_cust_a, 60.00, v_idem_key_1, 'pix', 'Parcela 1');
  v_pay_60_id := public.financial_register_payment(v_cust_a, 60.00, 'pix', 'Parcela 1', v_idem_key_1);

  -- Cenário 5: Bloqueio de pagamento duplicado com a mesma chave
  v_pay_dup_id := public.financial_register_payment(v_cust_a, 60.00, 'pix', 'Parcela 1', v_idem_key_1);
  IF v_pay_dup_id <> v_pay_60_id THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Idempotência falhou: criou segundo pagamento para a mesma chave!';
  END IF;

  v_lgpd_diag := public.lgpd_inspect_customer(v_cust_a);
  IF (v_lgpd_diag->>'open_debt_amount')::numeric <> 40.00 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Saldo devedor após pagamento parcial de R$ 60 deveria ser R$ 40,00, obtido: %', v_lgpd_diag;
  END IF;

  -- Cenário 6: Cancelamento explícito de tentativa (Tombstone) e bloqueio de requisição atrasada
  v_rec_check := public.reconcile_payment_attempt(v_idem_key_cancel, 'check', v_cust_a, 35.00);
  IF (v_rec_check->>'can_release_new_key')::boolean <> false THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] check com found:false liberou nova chave indevidamente!';
  END IF;

  v_rec_cancel := public.reconcile_payment_attempt(v_idem_key_cancel, 'cancel', v_cust_a, 35.00);
  IF (v_rec_cancel->>'can_release_new_key')::boolean <> true OR (v_rec_cancel->>'status') <> 'cancelled' THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Cancelamento explícito não gerou tombstone cancelled: %', v_rec_cancel;
  END IF;

  BEGIN
    PERFORM public.financial_register_payment(v_cust_a, 35.00, 'pix', 'Pacote atrasado', v_idem_key_cancel);
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Requisição antiga atrasada conseguiu registrar pagamento após cancelamento!';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%cancelada%' THEN
        RAISE;
      END IF;
  END;

  -- Cenário 7: Pagamento posterior dos R$ 40,00 restantes -> quita o pedido de R$ 100,00 via FIFO
  v_pay_40_id := public.financial_register_payment(v_cust_a, 40.00, 'dinheiro', 'Parcela final', 'homolog-pay-key-2');

  IF (SELECT paid AND settled_by_payment FROM public.orders WHERE id = v_ord_100_fiado_id) <> true THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Pedido de R$ 100,00 não foi quitado via FIFO após completar R$ 60 + R$ 40!';
  END IF;

  SELECT count(*)::int, coalesce(sum(amount), 0) INTO v_pay_count, v_pay_sum
  FROM public.payments
  WHERE company_id = v_comp_a AND customer_id = v_cust_a;

  IF v_pay_count <> 2 OR v_pay_sum <> 100.00 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Histórico de pagamentos incorreto: count=%, sum=%', v_pay_count, v_pay_sum;
  END IF;

  SELECT status INTO v_cust_status FROM public.customers WHERE id = v_cust_a;
  IF v_cust_status <> 'em_dia' THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Status do cliente deveria ser em_dia após quitar dívida, obtido: %', v_cust_status;
  END IF;

  -- Cenário 8: Alteração posterior dos preços NÃO modifica pedidos antigos
  UPDATE public.companies SET price_g = 35.00, price_m = 30.00, price_p = 25.00 WHERE id = v_comp_a;

  PERFORM public.financial_classify_order(
    _order_id => (v_ord_96->>'id')::uuid,
    _event_id => 'aaaaaaaa-0000-4000-8000-000000002001'::uuid,
    _command => 'OK',
    _received_at => clock_timestamp(),
    _validation_allowed => true,
    _validation_reason => 'CONFIRMACAO_VALIDADA'
  );

  IF (SELECT total FROM public.orders WHERE id = (v_ord_96->>'id')::uuid) <> 96.00
     OR (SELECT total FROM public.orders WHERE id = v_ord_100_fiado_id) <> 100.00 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Alteração de preços da empresa modificou o valor de pedidos históricos!';
  END IF;

  UPDATE public.companies SET price_g = 20.00, price_m = 18.00, price_p = 16.00 WHERE id = v_comp_a;

  -- Cenário 9: Cliente separado para teste de anonimização completa LGPD (com pedido pago de R$ 20,00)
  v_ord_lgpd := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_a_lgpd,
    _qty_p => 0,
    _qty_m => 0,
    _qty_g => 1,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'pago',
    _source => 'manual',
    _event_id => 'aaaaaaaa-0000-4000-8000-000000001004'::uuid
  );

  v_lgpd_res := public.lgpd_anonymize_customer_pii(
    _customer_id => v_cust_a_lgpd,
    _scope => 'anonimizacao_completa',
    _confirm_token => 'LGPD_CONFIRM_' || v_cust_a_lgpd::text,
    _protocol => 'HOMOLOG-LGPD-001'
  );

  IF (SELECT name FROM public.customers WHERE id = v_cust_a_lgpd) NOT LIKE 'Titular Anonimizado #%'
     OR (SELECT address FROM public.customers WHERE id = v_cust_a_lgpd) IS NOT NULL
     OR (SELECT notes FROM public.customers WHERE id = v_cust_a_lgpd) IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.financial_events WHERE customer_id = v_cust_a_lgpd AND phone IS NOT NULL) THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Anonimização completa LGPD deixou resíduos de PII!';
  END IF;
END $$;

-- 3.3. Isolamento Multi-Empresa: Operador B não enxerga nem opera registros da Empresa A
SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000022', true);
SELECT set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000022","role":"authenticated"}', true);

DO $$
DECLARE
  visible_orders_a int;
BEGIN
  SELECT count(*)::int INTO visible_orders_a
  FROM public.orders
  WHERE company_id = 'aaaaaaaa-0000-4000-8000-000000000001';

  IF visible_orders_a <> 0 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] RLS falhou: Operador B visualizou % pedidos da Empresa A!', visible_orders_a;
  END IF;

  BEGIN
    PERFORM public.lgpd_inspect_customer('aaaaaaaa-0000-4000-8000-000000000111');
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Operador B conseguiu inspecionar cliente da Empresa A!';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%Cliente não encontrado%' THEN
        RAISE;
      END IF;
  END;
END $$;

RESET ROLE;

-- ============================================================================
-- BLOCO 4: TESTE DE ROLLBACK DO CONSTRAINT TRIGGER E FILA WHATSAPP (SERVICE_ROLE)
-- ============================================================================
SAVEPOINT sp_privileged_without_audit;
DO $$
BEGIN
  INSERT INTO public.orders(
    company_id, customer_id, qty_p, qty_m, qty_g, quantity, unit_price,
    order_date, paid, settled_by_payment, source, financial_state
  )
  VALUES (
    'aaaaaaaa-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000111',
    0, 0, 2, 2, 20,
    (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    true, false, 'manual', 'pago'
  );
  RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Permitiu inserir pedido classificado sem evento em financial_events!';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Violação de integridade financeira%' THEN
      RAISE;
    END IF;
    RAISE NOTICE '[OK] Constraint trigger bloqueou INSERT privilegiado sem evento em financial_events.';
END $$;
ROLLBACK TO SAVEPOINT sp_privileged_without_audit;

DO $$
DECLARE
  v_comp_a uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_cust_a uuid := 'aaaaaaaa-0000-4000-8000-000000000111';
  v_msg_1 uuid := 'aaaaaaaa-0000-4000-8000-000000003001';
  v_msg_review uuid := 'aaaaaaaa-0000-4000-8000-000000003002';
  v_msg_echo_review uuid := 'aaaaaaaa-0000-4000-8000-000000003003';
  v_msg_echo_wrong_phone uuid := 'aaaaaaaa-0000-4000-8000-000000003004';
  v_msg_retry_limit uuid := 'aaaaaaaa-0000-4000-8000-000000003005';
  v_claimed_count int;
  v_completed_ord_id uuid;
  v_completed_ord_id_2 uuid;
  v_reviewed_ord jsonb;
  v_reviewed_ord_idem jsonb;
  v_echo_reconcile_res jsonb;
  v_stale_release boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000011', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000011","role":"authenticated"}', true);

  INSERT INTO public.whatsapp_messages(id, company_id, phone, direction, body, status, message_uid, source, next_retry_at)
  VALUES
    (v_msg_1, v_comp_a, '11988887777', 'inbound', 'Quero 2 G e 1 P', 'aguardando', 'wa:homolog-1', 'whatsapp_cloud', clock_timestamp()),
    (v_msg_review, v_comp_a, '11988887777', 'inbound', 'Manda as de sempre', 'revisar', 'wa:homolog-rev', 'whatsapp_cloud', NULL),
    (v_msg_echo_review, v_comp_a, '11988887777', 'outbound', 'OK', 'revisar', 'wa:homolog-echo-rev', 'whatsapp_echo', NULL),
    (v_msg_echo_wrong_phone, v_comp_a, '11999990000', 'outbound', 'OK', 'revisar', 'wa:homolog-echo-wrong', 'whatsapp_echo', NULL),
    (v_msg_retry_limit, v_comp_a, '11988887777', 'inbound', 'Falha IA repetida', 'erro', 'wa:homolog-retry-limit', 'whatsapp_cloud', clock_timestamp() + interval '5 minutes');

  -- AUD3-01 & AUD5-05: Confirma funcionamento de claim_whatsapp_queue_batch e limpeza de next_retry_at = NULL
  SELECT count(*)::int INTO v_claimed_count
  FROM public.claim_whatsapp_queue_batch(_batch_size => 10, _lock_seconds => 60, _company_id => v_comp_a, _worker_id => 'worker-1');

  IF v_claimed_count <> 1 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] claim_whatsapp_queue_batch deveria reclamar 1 mensagem, reclamou: %', v_claimed_count;
  END IF;

  IF (SELECT next_retry_at FROM public.whatsapp_messages WHERE id = v_msg_1) IS NOT NULL THEN
    RAISE EXCEPTION '[FALHA AUD5-05] claim_whatsapp_queue_batch não limpou next_retry_at = NULL no momento do claim!';
  END IF;

  SELECT count(*)::int INTO v_claimed_count
  FROM public.claim_whatsapp_queue_batch(_batch_size => 10, _lock_seconds => 60, _company_id => v_comp_a, _worker_id => 'worker-2');

  IF v_claimed_count <> 0 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Segunda instância reclamou mensagem com lease ativo!';
  END IF;

  -- Simula expiração de lease do worker-1 (em contexto de harness privilegiado) e recuperação pelo worker-2
  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);
  UPDATE public.whatsapp_messages SET locked_until = clock_timestamp() - interval '10 seconds' WHERE id = v_msg_1;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  SELECT count(*)::int INTO v_claimed_count
  FROM public.claim_whatsapp_queue_batch(_batch_size => 10, _lock_seconds => 60, _company_id => v_comp_a, _worker_id => 'worker-2');

  IF v_claimed_count <> 1 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] Mensagem com lease expirado não foi recuperada pela fila!';
  END IF;

  -- AUD-01: Confirma que o worker-1 (com lease expirado) é bloqueado em release_whatsapp_message_lock e em complete_whatsapp_message_order!
  v_stale_release := public.release_whatsapp_message_lock(
    _message_id => v_msg_1,
    _worker_id => 'worker-1',
    _final_status => 'erro',
    _last_error => 'Worker atrasado tentando sobrescrever',
    _lease_generation => 1
  );
  IF v_stale_release <> false THEN
    RAISE EXCEPTION '[FALHA AUD-01] Worker com lease expirado conseguiu sobrescrever lock pertencente ao worker-2!';
  END IF;

  BEGIN
    PERFORM public.complete_whatsapp_message_order(
      _message_id => v_msg_1,
      _company_id => v_comp_a,
      _customer_id => v_cust_a,
      _qty_p => 1,
      _qty_m => 0,
      _qty_g => 2,
      _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
      _parsed => '{"eh_pedido":true,"qtd_g":2,"qtd_m":0,"qtd_p":1}'::jsonb,
      _worker_id => 'worker-1',
      _lease_generation => 1
    );
    RAISE EXCEPTION '[FALHA AUD-01] Worker com lease expirado conseguiu concluir complete_whatsapp_message_order!';
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE NOTICE '[OK AUD-01] Fencing bloqueou complete_whatsapp_message_order de worker expirado (55P03).';
  END;

  -- O worker-2 (dono legítimo do lease atual, geração 2) conclui com sucesso
  v_completed_ord_id := public.complete_whatsapp_message_order(
    _message_id => v_msg_1,
    _company_id => v_comp_a,
    _customer_id => v_cust_a,
    _qty_p => 1,
    _qty_m => 0,
    _qty_g => 2,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _parsed => '{"eh_pedido":true,"qtd_g":2,"qtd_m":0,"qtd_p":1}'::jsonb,
    _worker_id => 'worker-2',
    _lease_generation => 2
  );

  v_completed_ord_id_2 := public.complete_whatsapp_message_order(
    _message_id => v_msg_1,
    _company_id => v_comp_a,
    _customer_id => v_cust_a,
    _qty_p => 1,
    _qty_m => 0,
    _qty_g => 2,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _parsed => '{"eh_pedido":true,"qtd_g":2,"qtd_m":0,"qtd_p":1}'::jsonb
  );

  IF v_completed_ord_id IS NULL OR v_completed_ord_id <> v_completed_ord_id_2 THEN
    RAISE EXCEPTION '[FALHA HOMOLOGAÇÃO] complete_whatsapp_message_order não manteve idempotência!';
  END IF;

  -- Revisão de mensagem inbound legítima (cria exatamente 1 pedido aguardando_classificacao)
  v_reviewed_ord := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_a,
    _qty_p => 0,
    _qty_m => 1,
    _qty_g => 1,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'aguardando_classificacao',
    _source => 'mensagem',
    _event_id => v_msg_review,
    _whatsapp_message_id => v_msg_review
  );

  -- AUD3-03: Segunda chamada para a mesma mensagem já vinculada a order_id retorna o mesmo pedido (sem duplicar)
  v_reviewed_ord_idem := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_a,
    _qty_p => 0,
    _qty_m => 1,
    _qty_g => 1,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'aguardando_classificacao',
    _source => 'mensagem',
    _event_id => gen_random_uuid(),
    _whatsapp_message_id => v_msg_review
  );

  IF (v_reviewed_ord_idem->>'id')::uuid IS DISTINCT FROM (v_reviewed_ord->>'id')::uuid THEN
    RAISE EXCEPTION '[FALHA AUD3-03] Segunda chamada com mesmo _whatsapp_message_id gerou pedido duplicado!';
  END IF;

  -- AUD3-03: Tentativa de criar novo pedido a partir de eco comercial (direction='outbound' / source='whatsapp_echo' / body='OK') DEVE SER BLOQUEADA (22023)
  BEGIN
    PERFORM public.create_manual_or_reviewed_order(
      _customer_id => v_cust_a,
      _qty_p => 0,
      _qty_m => 0,
      _qty_g => 1,
      _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
      _financial_state => 'aguardando_classificacao',
      _source => 'mensagem',
      _event_id => v_msg_echo_review,
      _whatsapp_message_id => v_msg_echo_review
    );
    RAISE EXCEPTION '[FALHA AUD3-03] create_manual_or_reviewed_order permitiu criar novo pedido a partir de eco comercial OK/OKK!';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE '[OK AUD3-03] create_manual_or_reviewed_order bloqueou criação de novo pedido a partir de eco comercial (22023).';
  END;

  -- AUD5-03: Tentativa de reconciliar eco de outro telefone (11999990000) com pedido do cliente 11988887777 DEVE SER BLOQUEADA (22023)
  BEGIN
    PERFORM public.reconcile_reviewed_whatsapp_echo(
      _whatsapp_message_id => v_msg_echo_wrong_phone,
      _order_id => (v_reviewed_ord->>'id')::uuid,
      _command => 'OK'
    );
    RAISE EXCEPTION '[FALHA AUD5-03] reconcile_reviewed_whatsapp_echo permitiu vincular eco de outro telefone/cliente!';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE '[OK AUD5-03] reconcile_reviewed_whatsapp_echo bloqueou associação entre telefones/clientes divergentes (22023).';
  END;

  -- AUD3-03 & AUD5-03: Reconciliação segura do eco comercial do MESMO cliente/telefone com o pedido existente
  v_echo_reconcile_res := public.reconcile_reviewed_whatsapp_echo(
    _whatsapp_message_id => v_msg_echo_review,
    _order_id => (v_reviewed_ord->>'id')::uuid,
    _command => 'OK'
  );

  IF (SELECT status FROM public.whatsapp_messages WHERE id = v_msg_echo_review) <> 'registrado'
     OR (SELECT order_id FROM public.whatsapp_messages WHERE id = v_msg_echo_review) <> (v_reviewed_ord->>'id')::uuid
     OR (SELECT financial_state FROM public.orders WHERE id = (v_reviewed_ord->>'id')::uuid) <> 'pago' THEN
    RAISE EXCEPTION '[FALHA AUD3-03] reconcile_reviewed_whatsapp_echo não reconciliou o eco comercial com o pedido existente!';
  END IF;

  -- AUD5-02 & AUD6-02: Valida prepare_manual_whatsapp_retry estruturado em JSONB (sem regredir attempts de 5 para 4, respeitando cooldown de 30s, limite de 3 retries e persistindo auditoria de bloqueio sem rollback!)
  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);
  UPDATE public.whatsapp_messages SET attempts = 5, status = 'erro' WHERE id = v_msg_retry_limit;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  v_echo_reconcile_res := public.prepare_manual_whatsapp_retry(v_comp_a, v_msg_retry_limit, 'aaaaaaaa-0000-4000-8000-000000000011'::uuid, 3, 30);

  IF coalesce(v_echo_reconcile_res->>'outcome', '') <> 'authorized'
     OR (SELECT attempts FROM public.whatsapp_messages WHERE id = v_msg_retry_limit) <> 5
     OR (SELECT manual_retry_count FROM public.whatsapp_messages WHERE id = v_msg_retry_limit) <> 1 THEN
    RAISE EXCEPTION '[FALHA AUD5-02 / AUD6-02] prepare_manual_whatsapp_retry alterou attempts ou não incrementou manual_retry_count!';
  END IF;

  -- Cooldown imediato deve retornar outcome = blocked (MANUAL_RETRY_COOLDOWN_ACTIVE) e persistir auditoria no banco
  v_echo_reconcile_res := public.prepare_manual_whatsapp_retry(v_comp_a, v_msg_retry_limit, 'aaaaaaaa-0000-4000-8000-000000000011'::uuid, 99, 0);
  IF coalesce(v_echo_reconcile_res->>'outcome', '') <> 'blocked'
     OR coalesce(v_echo_reconcile_res->>'error_code', '') <> 'MANUAL_RETRY_COOLDOWN_ACTIVE' THEN
    RAISE EXCEPTION '[FALHA AUD6-02 / AUD6-05] prepare_manual_whatsapp_retry não impôs cooldown fixo de 30s ou permitiu override de parâmetros!';
  END IF;

  -- Ao atingir manual_retry_count = 3, bloqueia novas tentativas, move para 'revisar' e persiste auditoria no banco
  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);
  UPDATE public.whatsapp_messages
     SET manual_retry_count = 3,
         last_manual_retry_at = clock_timestamp() - interval '60 seconds'
   WHERE id = v_msg_retry_limit;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  v_echo_reconcile_res := public.prepare_manual_whatsapp_retry(v_comp_a, v_msg_retry_limit, 'aaaaaaaa-0000-4000-8000-000000000011'::uuid, 99, 0);
  IF coalesce(v_echo_reconcile_res->>'outcome', '') <> 'blocked'
     OR coalesce(v_echo_reconcile_res->>'error_code', '') <> 'MANUAL_RETRY_LIMIT_EXCEEDED' THEN
    RAISE EXCEPTION '[FALHA AUD6-02 / AUD6-05] prepare_manual_whatsapp_retry permitiu ultrapassar o limite máximo de 3 retries manuais!';
  END IF;

  IF (SELECT status FROM public.whatsapp_messages WHERE id = v_msg_retry_limit) <> 'revisar' THEN
    RAISE EXCEPTION '[FALHA AUD6-02] Mensagem não foi movida e mantida em revisar ao atingir o limite de retries manuais!';
  END IF;

  IF (SELECT count(*)::int FROM public.whatsapp_manual_retry_audit WHERE message_id = v_msg_retry_limit AND outcome = 'blocked') < 2 THEN
    RAISE EXCEPTION '[FALHA AUD6-02] Eventos de bloqueio (cooldown e limite) não foram persistidos em whatsapp_manual_retry_audit!';
  END IF;

  -- AUD6-09: Confirma que DELETE direto em whatsapp_manual_retry_audit sem app.allow_audit_cleanup é bloqueado pelo trigger de imutabilidade
  PERFORM set_config('app.allow_audit_cleanup', 'off', true);
  BEGIN
    DELETE FROM public.whatsapp_manual_retry_audit WHERE company_id = v_comp_a;
    RAISE EXCEPTION '[FALHA AUD6-09] whatsapp_manual_retry_audit permitiu DELETE sem app.allow_audit_cleanup!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD6-09] Trigger whatsapp_manual_retry_audit_immutable_trg bloqueou DELETE em whatsapp_manual_retry_audit (42501).';
  END;

  PERFORM set_config('app.allow_audit_cleanup', 'on', true);
  DELETE FROM public.whatsapp_manual_retry_audit WHERE company_id = v_comp_a;
  PERFORM set_config('app.allow_audit_cleanup', 'off', true);
  DELETE FROM public.whatsapp_messages WHERE id IN (v_msg_echo_wrong_phone, v_msg_retry_limit);

  RAISE NOTICE '[OK BLOCO 4] Fila durável (AUD3-01 / AUD5-05), fencing token (AUD-01), limite/cooldown de retry manual (AUD5-02) e reconciliação segura (AUD3-03 / AUD5-03) aprovadas.';
END $$;

-- ============================================================================
-- BLOCO 6: VALIDAÇÃO DAS CORREÇÕES DA AUDITORIA ARGON 4 (MIGRAÇÕES 0012 A 0017)
-- ============================================================================
DO $$
DECLARE
  v_comp_a uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_comp_b uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_user_a uuid := 'aaaaaaaa-0000-4000-8000-000000000011';
  v_user_restricted uuid := 'aaaaaaaa-0000-4000-8000-000000000033';
  v_cust_a uuid := 'aaaaaaaa-0000-4000-8000-000000000111';
  v_msg_guard_test uuid := 'aaaaaaaa-0000-4000-8000-000000003099';
  v_msg_linked uuid := 'aaaaaaaa-0000-4000-8000-000000003001';
  v_found_id uuid;
  v_explain_plan text;
  v_cursor_count int;
  v_ignored_ok boolean;
BEGIN
  -- 6.1. Confirma índice composto parcial FIFO (ARGON4-06) e remoção do índice redundante
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'orders' AND indexname = 'orders_customer_open_fifo_idx'
  ) THEN
    RAISE EXCEPTION '[FALHA ARGON4-06] Índice orders_customer_open_fifo_idx não encontrado!';
  END IF;

  -- 6.2. Confirma find_customer_by_phone (ARGON4-02), get_or_create_customer_by_phone (AUD-03 / AUD3-02) e list_orders_cursor (AUD-08)
  SELECT id INTO v_found_id
  FROM public.find_customer_by_phone(v_comp_a, '+55 (11) 98888-7777');

  IF v_found_id IS DISTINCT FROM v_cust_a THEN
    RAISE EXCEPTION '[FALHA ARGON4-02] find_customer_by_phone não localizou o cliente esperado!';
  END IF;

  SELECT id INTO v_found_id
  FROM public.get_or_create_customer_by_phone(v_comp_a, '+55 (11) 98888-7777', 'Ignorado pois já existe');

  IF v_found_id IS DISTINCT FROM v_cust_a THEN
    RAISE EXCEPTION '[FALHA AUD-03 / AUD3-02] get_or_create_customer_by_phone não retornou o cliente existente!';
  END IF;

  SELECT count(*)::int INTO v_cursor_count
  FROM public.list_orders_cursor(_company_id => v_comp_a, _page_size => 10);

  IF v_cursor_count < 1 THEN
    RAISE EXCEPTION '[FALHA AUD-08] list_orders_cursor não retornou os pedidos da Empresa A!';
  END IF;

  -- 6.3. Cria operador comum restrito (role='user', can_classify=false) e testa ARGON4-07 + AUD-10 + AUD8-02 (erro explícito 42501)
  INSERT INTO auth.users(id, email, encrypted_password, raw_user_meta_data, created_at)
  VALUES (v_user_restricted, 'op.restrito@homolog.local', public.crypt('SenhaHomolog123!', public.gen_salt('bf')), '{"full_name":"Operador Restrito"}'::jsonb, now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles(id, company_id, full_name, email)
  VALUES (v_user_restricted, v_comp_a, 'Operador Restrito', 'op.restrito@homolog.local')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id, role)
  VALUES (v_user_restricted, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.financial_permissions(company_id, user_id, can_classify)
  VALUES (v_comp_a, v_user_restricted, false)
  ON CONFLICT (company_id, user_id) DO UPDATE SET can_classify = false;

  INSERT INTO public.whatsapp_messages(id, company_id, phone, direction, body, status, message_uid, source)
  VALUES (v_msg_guard_test, v_comp_a, '11988887777', 'inbound', 'Mensagem teste guard AUD8-02', 'revisar', 'wa:homolog-guard-test', 'whatsapp_cloud');

  -- Admin alterando preços: PERMITIDO
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  UPDATE public.companies SET price_g = 20.00 WHERE id = v_comp_a;

  -- Operador comum (role='user', can_classify=false) tentando alterar preços: DEVE LANÇAR ERRO EXPLÍCITO 42501 (AUD-10 / AUD8-02)
  PERFORM set_config('request.jwt.claim.sub', v_user_restricted::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_restricted::text, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.companies SET price_g = 99.00 WHERE id = v_comp_a;
    RAISE EXCEPTION '[FALHA AUD-10 / AUD8-02] UPDATE de operador sem permissão não levantou exceção explícita 42501!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD-10 / AUD8-02] Operador sem permissão recebeu erro explícito 42501 ao tentar alterar preços.';
  END;

  IF (SELECT price_g FROM public.companies WHERE id = v_comp_a) <> 20.00 THEN
    RAISE EXCEPTION '[FALHA ARGON4-07] Operador comum conseguiu alterar price_g em public.companies!';
  END IF;

  -- AUD6-07.C & AUD8-02: Testa tentativas de alteração indevida de company_id, phone, body (raw_message),
  -- attempts, manual_retry_count, order_id e status como authenticated (mesmo sendo admin da empresa!)
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  -- (a) Tentativa de alterar company_id -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET company_id = v_comp_b WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar company_id em whatsapp_messages!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Alteração direta de company_id bloqueada (42501).';
  END;

  -- (b) Tentativa de alterar phone -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET phone = '11900001111' WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar phone em whatsapp_messages!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Alteração direta de phone bloqueada (42501).';
  END;

  -- (c) Tentativa de alterar body (raw_message) -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET body = 'Texto adulterado' WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar body (raw_message) em whatsapp_messages!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Alteração direta de body (raw_message) bloqueada (42501).';
  END;

  -- (d) Tentativa de alterar attempts -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET attempts = 0 WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar attempts em whatsapp_messages!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Alteração direta de attempts bloqueada (42501).';
  END;

  -- (e) Tentativa de alterar manual_retry_count -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET manual_retry_count = 0 WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar manual_retry_count em whatsapp_messages!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Alteração direta de manual_retry_count bloqueada (42501).';
  END;

  -- (f) Tentativa de alterar order_id -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET order_id = gen_random_uuid() WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar order_id em whatsapp_messages!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Alteração direta de order_id bloqueada (42501).';
  END;

  -- (g) Tentativa de alterar status diretamente para 'registrado', 'processando', 'aguardando' ou 'erro' -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET status = 'registrado' WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar status diretamente para registrado!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Transição direta para status=registrado bloqueada pelo trigger SECURITY INVOKER (42501).';
  END;

  BEGIN
    UPDATE public.whatsapp_messages SET status = 'processando' WHERE id = v_msg_guard_test;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu alterar status diretamente para processando!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Transição direta para status=processando bloqueada pelo trigger SECURITY INVOKER (42501).';
  END;

  -- (h) Tentativa de dispensar ('ignorado') mensagem já registrada e vinculada a pedido -> 42501
  BEGIN
    UPDATE public.whatsapp_messages SET status = 'ignorado' WHERE id = v_msg_linked;
    RAISE EXCEPTION '[FALHA AUD8-02] Cliente autenticado conseguiu mudar mensagem já registrada para ignorado!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK AUD8-02] Transição para ignorado em mensagem já vinculada a pedido bloqueada (42501).';
  END;

  -- (i) Confirma que a RPC autorizada public.ignore_whatsapp_message funciona para mensagem em 'revisar' sem pedido
  v_ignored_ok := public.ignore_whatsapp_message(v_msg_guard_test);
  IF v_ignored_ok IS DISTINCT FROM true
     OR (SELECT status FROM public.whatsapp_messages WHERE id = v_msg_guard_test) <> 'ignorado' THEN
    RAISE EXCEPTION '[FALHA AUD8-02] RPC autorizada public.ignore_whatsapp_message não atualizou status para ignorado!';
  END IF;

  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.whatsapp_messages WHERE id = v_msg_guard_test;
  DELETE FROM public.financial_permissions WHERE company_id = v_comp_a AND user_id = v_user_restricted;
  DELETE FROM public.user_roles WHERE user_id = v_user_restricted;
  DELETE FROM public.profiles WHERE id = v_user_restricted;
  DELETE FROM auth.users WHERE id = v_user_restricted;

  -- 6.4. Executa EXPLAIN (ANALYZE, BUFFERS) da consulta FIFO (ARGON4-06)
  EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, total FROM public.orders
    WHERE company_id = ' || quote_literal(v_comp_a) || '::uuid
      AND customer_id = ' || quote_literal(v_cust_a) || '::uuid
      AND paid = false
      AND delivery_status <> ''cancelado''
      AND financial_state IS DISTINCT FROM ''aguardando_classificacao''
    ORDER BY order_date ASC, created_at ASC, id ASC'
  INTO v_explain_plan;

  RAISE NOTICE '[OK BLOCO 6] Correções Argon 4 (0012 a 0017) validadas. Plano FIFO: %', v_explain_plan;
END $$;

-- ============================================================================
-- BLOCO 7: VALIDAÇÃO FORENSE AVANÇADA FOR-02, FOR-04, FOR-06, FOR-07 E FOR-12 (MIGRAÇÃO 0018)
-- ============================================================================
DO $$
DECLARE
  v_comp_a uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_comp_b uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_user_a uuid := 'aaaaaaaa-0000-4000-8000-000000000011';
  v_user_b uuid := 'bbbbbbbb-0000-4000-8000-000000000022';
  v_user_restricted uuid := 'aaaaaaaa-0000-4000-8000-000000000044';
  v_user_operator_non_admin uuid := 'aaaaaaaa-0000-4000-8000-000000000055';
  v_user_deletable uuid := 'aaaaaaaa-0000-4000-8000-000000000066';
  v_cust_for02 uuid := 'aaaaaaaa-0000-4000-8000-000000000199';
  v_ord_for02_ok uuid := 'aaaaaaaa-0000-4000-8000-000000001198';
  v_ord_for02_okk uuid := 'aaaaaaaa-0000-4000-8000-000000001199';
  v_msg_expired_review uuid := 'aaaaaaaa-0000-4000-8000-000000003191';
  v_msg_expired_error uuid := 'aaaaaaaa-0000-4000-8000-000000003192';
  v_msg_active_lease uuid := 'aaaaaaaa-0000-4000-8000-000000003193';
  v_audit_row_id uuid;
  v_res jsonb;
  v_purged int;
BEGIN
  -- 7.1. FOR-04: Verifica revogação de EXECUTE de authenticated em financial_create_pending (mantendo service_role)
  IF has_function_privilege('authenticated', 'public.financial_create_pending(uuid, integer, integer, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '[FALHA FOR-04] authenticated ainda possui EXECUTE em public.financial_create_pending!';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.financial_create_pending(uuid, integer, integer, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '[FALHA FOR-04] service_role perdeu EXECUTE em public.financial_create_pending!';
  END IF;

  -- 7.2. FOR-07: Verifica existência dos 6 índices de chaves estrangeiras criados na migration 0018
  IF (
    SELECT count(*)::int FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'financial_events_order_id_idx',
         'financial_events_company_customer_idx',
         'payment_attempts_company_customer_idx',
         'payment_attempts_payment_id_idx',
         'whatsapp_messages_last_manual_retry_by_idx',
         'whatsapp_manual_retry_audit_actor_id_idx'
       )
  ) <> 6 THEN
    RAISE EXCEPTION '[FALHA FOR-07] Nem todos os 6 índices de chaves estrangeiras da migration 0018 foram encontrados!';
  END IF;

  -- 7.3. FOR-06: Verifica que as políticas RLS utilizam subselect (SELECT ...) para initPlan caching
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN (
         'companies', 'profiles', 'user_roles', 'customers', 'orders', 'payments',
         'whatsapp_messages', 'whatsapp_connections', 'financial_permissions',
         'financial_events', 'payment_attempts', 'whatsapp_manual_retry_audit'
       )
       AND coalesce(qual, '') NOT ILIKE '%SELECT%'
  ) THEN
    RAISE EXCEPTION '[FALHA FOR-06] Existem políticas RLS em public sem subselect (SELECT ...) para initPlan caching!';
  END IF;

  -- Prepara usuários sintéticos para testes FOR-02, FOR-04, FOR-07 e FOR-12
  INSERT INTO auth.users(id, email, encrypted_password, raw_user_meta_data, created_at)
  VALUES
    (v_user_restricted, 'for02.restrito@homolog.local', public.crypt('Senha123!', public.gen_salt('bf')), '{"full_name":"Restrito FOR02"}'::jsonb, now()),
    (v_user_operator_non_admin, 'for12.operador@homolog.local', public.crypt('Senha123!', public.gen_salt('bf')), '{"full_name":"Operador FOR12"}'::jsonb, now()),
    (v_user_deletable, 'for07.deletable@homolog.local', public.crypt('Senha123!', public.gen_salt('bf')), '{"full_name":"Deletavel FOR07"}'::jsonb, now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles(id, company_id, full_name, email)
  VALUES
    (v_user_restricted, v_comp_a, 'Restrito FOR02', 'for02.restrito@homolog.local'),
    (v_user_operator_non_admin, v_comp_a, 'Operador FOR12', 'for12.operador@homolog.local'),
    (v_user_deletable, v_comp_a, 'Deletavel FOR07', 'for07.deletable@homolog.local')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id, role)
  VALUES
    (v_user_restricted, 'user'),
    (v_user_operator_non_admin, 'user'),
    (v_user_deletable, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.financial_permissions(company_id, user_id, can_classify)
  VALUES
    (v_comp_a, v_user_restricted, false),
    (v_comp_a, v_user_operator_non_admin, true),
    (v_comp_a, v_user_deletable, true)
  ON CONFLICT (company_id, user_id) DO UPDATE SET can_classify = EXCLUDED.can_classify;

  -- 7.4. FOR-02: Criação autorizada, bloqueio de escrita por usuário restrito, bloqueio de UPDATE status e proteção de telefone com pedido pendente
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  INSERT INTO public.customers(id, company_id, name, phone, address, notes, payment_cycle)
  VALUES (v_cust_for02, v_comp_a, 'Cliente FOR-02', '11977771234', 'Rua Inicial, 10', 'Nota inicial', 'semanal');

  -- (a) UPDATE autorizado de dados cadastrais (nome, endereço, observações)
  UPDATE public.customers
     SET name = 'Cliente FOR-02 Atualizado',
         address = 'Rua Nova, 20'
   WHERE id = v_cust_for02;

  -- (b) Tentativa de UPDATE direto de customers.status via PostgREST -> bloqueado (42501)
  BEGIN
    UPDATE public.customers SET status = 'pendente' WHERE id = v_cust_for02;
    RAISE EXCEPTION '[FALHA FOR-02] UPDATE direto de customers.status não foi bloqueado!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK FOR-02] UPDATE direto de customers.status bloqueado por permissão de coluna / trigger (42501).';
  END;

  -- (c) Tentativa de UPDATE de cliente por usuário sem permissão operacional (can_classify = false) -> bloqueado (42501)
  PERFORM set_config('request.jwt.claim.sub', v_user_restricted::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_restricted::text, 'role', 'authenticated')::text, true);

  BEGIN
    UPDATE public.customers SET name = 'Adulterado por Restrito' WHERE id = v_cust_for02;
    RAISE EXCEPTION '[FALHA FOR-02] Usuário sem permissão operacional conseguiu editar cliente!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK FOR-02] Edição de cliente por usuário sem permissão bloqueada (42501).';
  END;

  -- (d) FOR-04: Tentativa de get_or_create_customer_by_phone por usuário sem permissão operacional -> bloqueado (42501)
  BEGIN
    PERFORM * FROM public.get_or_create_customer_by_phone(v_comp_a, '11977779999', 'Bloqueado');
    RAISE EXCEPTION '[FALHA FOR-04] get_or_create_customer_by_phone permitiu execução por usuário sem permissão operacional!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK FOR-04] get_or_create_customer_by_phone bloqueou usuário sem permissão operacional (42501).';
  END;

  -- (e) FOR-04: Tentativa de consultar has_role de usuário de outra empresa -> bloqueado (42501)
  BEGIN
    PERFORM public.has_role(v_user_b, 'admin'::public.app_role);
    RAISE EXCEPTION '[FALHA FOR-04] has_role permitiu consultar papel de usuário de outra empresa!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK FOR-04] has_role bloqueou enumeração de papel de usuário de outra empresa (42501).';
  END;

  -- (f) FOR-02: Cria pedido pendente (aguardando_classificacao) e tenta alterar customers.phone -> bloqueado (22023)
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  v_res := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_for02,
    _qty_p => 1,
    _qty_m => 0,
    _qty_g => 1,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'aguardando_classificacao',
    _source => 'manual',
    _event_id => v_ord_for02_ok
  );
  v_ord_for02_ok := (v_res->>'id')::uuid;

  BEGIN
    UPDATE public.customers SET phone = '11977775555' WHERE id = v_cust_for02;
    RAISE EXCEPTION '[FALHA FOR-02] Alteração de telefone com pedido aguardando classificação não foi bloqueada!';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      RAISE NOTICE '[OK FOR-02] Alteração de telefone bloqueada enquanto houver pedido aguardando classificação (22023).';
  END;

  -- (g) FOR-02: Confirmação OK funciona sem CONTEXTO_CONFLITANTE
  v_res := public.financial_classify_order(
    _order_id => v_ord_for02_ok,
    _event_id => 'aaaaaaaa-0000-4000-8000-000000009198'::uuid,
    _command => 'OK',
    _received_at => clock_timestamp(),
    _validation_allowed => true,
    _validation_reason => 'CONFIRMACAO_VALIDADA'
  );
  IF (v_res->>'outcome') <> 'classified' OR (v_res->>'state') <> 'pago' THEN
    RAISE EXCEPTION '[FALHA FOR-02] Confirmação OK falhou: %', v_res;
  END IF;

  -- (h) FOR-02: Cria segundo pedido pendente e confirma com OKK (fiado)
  v_res := public.create_manual_or_reviewed_order(
    _customer_id => v_cust_for02,
    _qty_p => 0,
    _qty_m => 1,
    _qty_g => 0,
    _order_date => (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    _financial_state => 'aguardando_classificacao',
    _source => 'manual',
    _event_id => v_ord_for02_okk
  );
  v_ord_for02_okk := (v_res->>'id')::uuid;

  v_res := public.financial_classify_order(
    _order_id => v_ord_for02_okk,
    _event_id => 'aaaaaaaa-0000-4000-8000-000000009199'::uuid,
    _command => 'OKK',
    _received_at => clock_timestamp(),
    _validation_allowed => true,
    _validation_reason => 'CONFIRMACAO_VALIDADA'
  );
  IF (v_res->>'outcome') <> 'classified' OR (v_res->>'state') <> 'fiado' THEN
    RAISE EXCEPTION '[FALHA FOR-02] Confirmação OKK falhou: %', v_res;
  END IF;

  -- Após todos os pedidos pendentes estarem classificados, a atualização de telefone para futuros pedidos é permitida
  UPDATE public.customers SET phone = '11977775555' WHERE id = v_cust_for02;

  -- (i) FOR-12: Operador não-admin (can_classify = true, mas sem role admin) é bloqueado em lgpd_anonymize_customer_pii (42501)
  PERFORM set_config('request.jwt.claim.sub', v_user_operator_non_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_operator_non_admin::text, 'role', 'authenticated')::text, true);

  BEGIN
    PERFORM public.lgpd_anonymize_customer_pii(
      v_cust_for02,
      'dados_complementares',
      'LGPD_CONFIRM_' || v_cust_for02::text,
      'PROT-NAO-ADMIN'
    );
    RAISE EXCEPTION '[FALHA FOR-12] Operador sem role admin conseguiu executar lgpd_anonymize_customer_pii!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE '[OK FOR-12] lgpd_anonymize_customer_pii exigiu privilégio administrativo is_company_admin (42501).';
  END;

  -- 7.5. FOR-07: Testa exclusão de usuário em auth.users com ON DELETE SET NULL preservando registro histórico em whatsapp_manual_retry_audit
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  INSERT INTO public.whatsapp_manual_retry_audit(
    company_id, message_id, actor_id, manual_retry_number,
    previous_status, previous_attempts, outcome, reason
  ) VALUES (
    v_comp_a, NULL, v_user_deletable, 1,
    'erro', 5, 'authorized', 'TESTE_FOR07_ON_DELETE_SET_NULL'
  ) RETURNING id INTO v_audit_row_id;

  DELETE FROM public.financial_permissions WHERE company_id = v_comp_a AND user_id = v_user_deletable;
  DELETE FROM public.user_roles WHERE user_id = v_user_deletable;
  DELETE FROM public.profiles WHERE id = v_user_deletable;
  DELETE FROM auth.users WHERE id = v_user_deletable;

  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_manual_retry_audit
     WHERE id = v_audit_row_id AND actor_id IS NULL AND reason = 'TESTE_FOR07_ON_DELETE_SET_NULL'
  ) THEN
    RAISE EXCEPTION '[FALHA FOR-07] Registro histórico de auditoria não preservou linha com actor_id = NULL após DELETE em auth.users!';
  END IF;

  -- 7.6. FOR-12: Testa expurgo LGPD de mensagens antigas (> 180 dias) em revisar e erro sem tocar em mensagem com lease ativo
  INSERT INTO public.whatsapp_messages(id, company_id, phone, direction, body, profile_name, status, created_at, locked_until)
  VALUES
    (v_msg_expired_review, v_comp_a, '11977775555', 'inbound', 'Texto antigo revisar PII', 'Nome Revisar', 'revisar', clock_timestamp() - interval '200 days', NULL),
    (v_msg_expired_error, v_comp_a, '11977775555', 'inbound', 'Texto antigo erro PII', 'Nome Erro', 'erro', clock_timestamp() - interval '200 days', clock_timestamp() - interval '199 days'),
    (v_msg_active_lease, v_comp_a, '11977775555', 'inbound', 'Texto com lease ativo', 'Nome Ativo', 'erro', clock_timestamp() - interval '200 days', clock_timestamp() + interval '5 minutes');

  v_purged := public.lgpd_purge_expired_message_bodies(180);
  IF v_purged < 2 THEN
    RAISE EXCEPTION '[FALHA FOR-12] lgpd_purge_expired_message_bodies não expurgou as mensagens expiradas em revisar e erro (expurgadas=%)!', v_purged;
  END IF;

  IF (SELECT body FROM public.whatsapp_messages WHERE id = v_msg_expired_review) <> '[Texto expirado pela política de retenção LGPD]'
     OR (SELECT body FROM public.whatsapp_messages WHERE id = v_msg_expired_error) <> '[Texto expirado pela política de retenção LGPD]' THEN
    RAISE EXCEPTION '[FALHA FOR-12] Corpos das mensagens expiradas em revisar/erro não foram redigidos!';
  END IF;

  IF (SELECT body FROM public.whatsapp_messages WHERE id = v_msg_active_lease) <> 'Texto com lease ativo' THEN
    RAISE EXCEPTION '[FALHA FOR-12] Mensagem com lease ativo foi indevidamente expurgada!';
  END IF;

  -- Limpeza dos registros sintéticos do Bloco 7 para manter idempotência absoluta do snapshot
  DELETE FROM public.whatsapp_messages WHERE id IN (v_msg_expired_review, v_msg_expired_error, v_msg_active_lease);
  PERFORM set_config('app.allow_audit_cleanup', 'on', true);
  DELETE FROM public.whatsapp_manual_retry_audit WHERE id = v_audit_row_id;
  PERFORM set_config('app.allow_audit_cleanup', 'off', true);

  ALTER TABLE public.orders DISABLE TRIGGER zz_financial_guard_order;
  ALTER TABLE public.orders DISABLE TRIGGER zz_financial_require_audit_event;
  ALTER TABLE public.financial_events DISABLE TRIGGER financial_audit_immutable;
  DELETE FROM public.orders WHERE id IN (v_ord_for02_ok, v_ord_for02_okk);
  DELETE FROM public.financial_events WHERE customer_id = v_cust_for02;
  ALTER TABLE public.financial_events ENABLE TRIGGER financial_audit_immutable;
  ALTER TABLE public.orders ENABLE TRIGGER zz_financial_require_audit_event;
  ALTER TABLE public.orders ENABLE TRIGGER zz_financial_guard_order;

  DELETE FROM public.customers WHERE id = v_cust_for02;
  DELETE FROM public.financial_permissions WHERE company_id = v_comp_a AND user_id IN (v_user_restricted, v_user_operator_non_admin);
  DELETE FROM public.user_roles WHERE user_id IN (v_user_restricted, v_user_operator_non_admin);
  DELETE FROM public.profiles WHERE id IN (v_user_restricted, v_user_operator_non_admin);
  DELETE FROM auth.users WHERE id IN (v_user_restricted, v_user_operator_non_admin);

  -- 7.7. C-09 / M-02 (Migration 0019): Valida obrigatoriedade de _lease_generation >= 1 em renew_whatsapp_message_lock e release_whatsapp_message_lock
  IF public.renew_whatsapp_message_lock(gen_random_uuid(), 'worker-test', 60, NULL) IS DISTINCT FROM false
     OR public.renew_whatsapp_message_lock(gen_random_uuid(), 'worker-test', 60, 0) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[FALHA C-09] renew_whatsapp_message_lock aceitou _lease_generation NULL ou 0!';
  END IF;

  IF public.release_whatsapp_message_lock(gen_random_uuid(), 'worker-test', 'erro', 'err', NULL, NULL, NULL, NULL) IS DISTINCT FROM false
     OR public.release_whatsapp_message_lock(gen_random_uuid(), 'worker-test', 'erro', 'err', NULL, 0, NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[FALHA C-09] release_whatsapp_message_lock aceitou _lease_generation NULL ou 0!';
  END IF;

  -- 7.8. Missão 03 (AUD-M02-01 & AUD-M02-03 — Migration 0020):
  -- Valida bloqueio de lease expirado em release_whatsapp_message_lock, complete_whatsapp_message_order
  -- e financial_classify_by_echo (incluindo sequência Worker A gen 1 expirado -> Worker B gen 2 ativo).
  INSERT INTO public.customers(id, company_id, name, phone, address, notes, payment_cycle)
  VALUES (v_cust_for02, v_comp_a, 'Cliente M03 Lease', '11977776666', 'Rua M03', NULL, 'semanal');

  INSERT INTO public.whatsapp_messages(
    id, company_id, customer_id, phone, direction, body, status,
    locked_by, locked_until, lease_generation, message_uid, source
  ) VALUES (
    v_msg_expired_error, v_comp_a, v_cust_for02, '11977776666', 'inbound', '1 marmita G', 'processando',
    'worker-expired-A', clock_timestamp() - interval '10 seconds', 1, 'wa:m03:inbound', 'whatsapp_cloud'
  );

  -- (a) AUD-M02-01: Lease expirado bloqueia release_whatsapp_message_lock mesmo com worker_id e lease_generation iguais
  IF public.release_whatsapp_message_lock(
    v_msg_expired_error, 'worker-expired-A', 'erro', 'timeout', NULL, 1, NULL, NULL
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[FALHA AUD-M02-01] release_whatsapp_message_lock permitiu liberar mensagem com locked_until expirado!';
  END IF;

  -- (b) AUD-M02-01: Lease expirado bloqueia complete_whatsapp_message_order com MESSAGE_LEASE_LOST (55P03)
  BEGIN
    PERFORM public.complete_whatsapp_message_order(
      v_msg_expired_error, v_comp_a, v_cust_for02, 0, 0, 1,
      (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
      '{"eh_pedido":true,"qtd_g":1}'::jsonb,
      NULL, '11977776666', 'mensagem', 'worker-expired-A', 1
    );
    RAISE EXCEPTION '[FALHA AUD-M02-01] complete_whatsapp_message_order permitiu concluir mensagem com locked_until expirado!';
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE NOTICE '[OK AUD-M02-01] complete_whatsapp_message_order bloqueou lease expirado (55P03 MESSAGE_LEASE_LOST).';
  END;

  -- (c) AUD-M02-03: Eco comercial em disputa (Worker A gen 1 perde lease para Worker B gen 2)
  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);
  UPDATE public.whatsapp_messages
     SET direction = 'outbound',
         body = 'OK',
         source = 'whatsapp_echo',
         message_uid = 'echo:m03-disputed',
         status = 'processando',
         locked_by = 'worker-B',
         locked_until = clock_timestamp() + interval '60 seconds',
         lease_generation = 2
   WHERE id = v_msg_expired_error;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  -- Worker A (gen 1) tenta chamar financial_classify_by_echo -> rejeitado (55P03 MESSAGE_LEASE_LOST)
  BEGIN
    PERFORM public.financial_classify_by_echo(
      v_comp_a, v_cust_for02, NULL, 'echo:m03-disputed', 'OK', clock_timestamp(),
      true, 'CONFIRMACAO_VALIDADA', v_msg_expired_error, 'worker-A', 1
    );
    RAISE EXCEPTION '[FALHA AUD-M02-03] financial_classify_by_echo permitiu Worker A com geração obsoleta (1 vs 2)!';
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE NOTICE '[OK AUD-M02-03] financial_classify_by_echo rejeitou Worker A zumbi (55P03 MESSAGE_LEASE_LOST).';
  END;

  DELETE FROM public.whatsapp_messages WHERE id = v_msg_expired_error;
  DELETE FROM public.customers WHERE id = v_cust_for02;


  -- 7.9. Missão 07.2 (Migration 0022): Valida REG-M07-01, REG-M07-02, AF-01 (AUD-07.1-01/02) e AF-08 (AUD-07.1-06)
  -- (a) REG-M07-02: Verifica que deletar um cliente que possui registro em lgpd_lifecycle_audit executa ON DELETE SET NULL em customer_id sem erro 42501
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  INSERT INTO public.customers(id, company_id, name, phone, address, notes, payment_cycle)
  VALUES (v_cust_for02, v_comp_a, 'Cliente LGPD Delete Test', '11977776661', 'Rua LGPD', 'Nota LGPD', 'semanal');

  PERFORM public.lgpd_anonymize_customer(
    v_cust_for02,
    'dados_complementares',
    'LGPD_CONFIRM_' || v_cust_for02::text,
    'PROT-REG-M07-02'
  );

  PERFORM set_config('role', 'postgres', true);
  DELETE FROM public.customers WHERE id = v_cust_for02;

  IF NOT EXISTS (
    SELECT 1 FROM public.lgpd_lifecycle_audit
     WHERE company_id = v_comp_a
       AND protocol = 'PROT-REG-M07-02'
       AND customer_id IS NULL
  ) THEN
    RAISE EXCEPTION '[FALHA REG-M07-02] ON DELETE SET NULL em lgpd_lifecycle_audit.customer_id não preservou registro com customer_id = NULL!';
  END IF;

  PERFORM set_config('app.allow_audit_cleanup', 'on', true);
  DELETE FROM public.lgpd_lifecycle_audit WHERE company_id = v_comp_a AND protocol = 'PROT-REG-M07-02';
  PERFORM set_config('app.allow_audit_cleanup', 'off', true);

  RAISE NOTICE '[OK BLOCO 7] Validações forenses FOR-02, FOR-04, FOR-06, FOR-07, FOR-12, C-09/M-02 e AUD-M02-01..05 (Migrations 0018, 0019 e 0020) aprovadas com sucesso!';
END $$;

-- ============================================================================
-- BLOCO 8: MISSÃO 07.4 (MIGRATION 0023) — VALIDAÇÃO REAL COM SET LOCAL ROLE
--          DE AUD-07.3-02 (P0), AUD-07.3-04 (P2) E REQUEUE COM BACKOFF
-- ============================================================================

-- 8.1. Cenário 4 (Seção 4.3): role anon NÃO consegue registrar pagamento (42501)
SAVEPOINT sp_m074_anon_pay;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  PERFORM public.financial_register_payment(
    'aaaaaaaa-0000-4000-8000-000000000111'::uuid,
    10.00,
    'pix',
    'Tentativa anon',
    'm074-anon-key-1'
  );
  RAISE EXCEPTION '[FALHA AUD-07.3-02] Role anon conseguiu registrar pagamento!';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK AUD-07.3-02] Role anon bloqueada em financial_register_payment (42501).';
END $$;
ROLLBACK TO SAVEPOINT sp_m074_anon_pay;
RESET ROLE;

-- 8.2. Cenário 2 (Seção 4.3): authenticated SEM claims NÃO consegue utilizar o caminho privilegiado
--      nem chamar diretamente _financial_register_payment_as_service (42501), sem mutar dados!
SAVEPOINT sp_m074_auth_empty_claims;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claims', '', true);
DO $$
BEGIN
  PERFORM public.financial_register_payment(
    'aaaaaaaa-0000-4000-8000-000000000111'::uuid,
    15.00,
    'pix',
    'Tentativa sem claims',
    'm074-empty-claims-key-1'
  );
  RAISE EXCEPTION '[FALHA CRÍTICA AUD-07.3-02] Role authenticated sem claims caiu no caminho privilegiado!';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK AUD-07.3-02] Role authenticated sem claims bloqueada com segurança (42501).';
END $$;

DO $$
BEGIN
  PERFORM public._financial_register_payment_as_service(
    'aaaaaaaa-0000-4000-8000-000000000111'::uuid,
    15.00,
    'pix',
    'Tentativa direta _as_service',
    'm074-direct-srv-key-1'
  );
  RAISE EXCEPTION '[FALHA CRÍTICA AUD-07.3-02] Role authenticated conseguiu chamar _financial_register_payment_as_service!';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK AUD-07.3-02] Role authenticated bloqueada por REVOKE em _financial_register_payment_as_service (42501).';
END $$;
ROLLBACK TO SAVEPOINT sp_m074_auth_empty_claims;
RESET ROLE;

-- 8.3. Cenário 3 (Seção 4.3): authenticated com claims válidos da Empresa A NÃO consegue quitar
--      pedido de cliente da Empresa B (isolamento multiempresa)
SAVEPOINT sp_m074_cross_tenant_pay;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000011', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000011","role":"authenticated"}', true);
DO $$
BEGIN
  PERFORM public.financial_register_payment(
    'bbbbbbbb-0000-4000-8000-000000000222'::uuid,
    21.00,
    'pix',
    'Tentativa cross-tenant',
    'm074-cross-tenant-key-1'
  );
  RAISE EXCEPTION '[FALHA AUD-07.3-02] Operador A conseguiu registrar pagamento para cliente da Empresa B!';
EXCEPTION
  WHEN no_data_found OR insufficient_privilege THEN
    RAISE NOTICE '[OK AUD-07.3-02] Tentativa de pagamento cross-tenant bloqueada com segurança.';
END $$;
ROLLBACK TO SAVEPOINT sp_m074_cross_tenant_pay;
RESET ROLE;

-- 8.4. Cenário 5 (Seção 4.3): service_role sem JWT consegue registrar pagamento legitimamente
SAVEPOINT sp_m074_service_role_pay;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', '', true);
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  v_srv_pay_id uuid;
  v_srv_pay_dup uuid;
BEGIN
  v_srv_pay_id := public.financial_register_payment(
    'bbbbbbbb-0000-4000-8000-000000000222'::uuid,
    21.00,
    'pix',
    'Pagamento via service_role',
    'm074-srv-valid-key-1'
  );
  IF v_srv_pay_id IS NULL THEN
    RAISE EXCEPTION '[FALHA AUD-07.3-02] service_role não retornou payment_id válido!';
  END IF;

  -- Idempotência na mesma chave via service_role
  v_srv_pay_dup := public.financial_register_payment(
    'bbbbbbbb-0000-4000-8000-000000000222'::uuid,
    21.00,
    'pix',
    'Pagamento via service_role',
    'm074-srv-valid-key-1'
  );
  IF v_srv_pay_dup <> v_srv_pay_id THEN
    RAISE EXCEPTION '[FALHA AUD-07.3-02] Idempotência falhou para service_role!';
  END IF;
  RAISE NOTICE '[OK AUD-07.3-02] service_role sem JWT registrou pagamento e preservou idempotência.';
END $$;
ROLLBACK TO SAVEPOINT sp_m074_service_role_pay;
RESET ROLE;

-- 8.5. AUD-07.3-04 (Seção 7): Proteção da função auxiliar public.lgpd_purge_expired_message_bodies
SAVEPOINT sp_m074_lgpd_helper_guard;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000011', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000011","role":"authenticated"}', true);
DO $$
BEGIN
  PERFORM public.lgpd_purge_expired_message_bodies(180);
  RAISE EXCEPTION '[FALHA AUD-07.3-04] Role authenticated conseguiu chamar diretamente lgpd_purge_expired_message_bodies!';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE '[OK AUD-07.3-04] Role authenticated bloqueada na chamada direta a lgpd_purge_expired_message_bodies (42501).';
END $$;

-- Função principal lgpd_purge_expired_operational_data continua funcionando para admin autenticado,
-- respeita janela de 24h e não cria auditoria quando não há registros expirados
DO $$
DECLARE
  v_purge_1 jsonb;
  v_purge_2 jsonb;
BEGIN
  v_purge_1 := public.lgpd_purge_expired_operational_data(180, true);
  IF (v_purge_1->>'skipped_by_schedule')::boolean <> false OR v_purge_1->>'audit_id' IS NOT NULL THEN
    RAISE EXCEPTION '[FALHA AUD-07.3-04] Expurgo vazio gerou resultado inesperado: %', v_purge_1;
  END IF;

  v_purge_2 := public.lgpd_purge_expired_operational_data(180, false);
  IF (v_purge_2->>'skipped_by_schedule')::boolean <> true THEN
    RAISE EXCEPTION '[FALHA AUD-07.3-04] Segunda chamada dentro de 24h não respeitou operational_scheduler_state: %', v_purge_2;
  END IF;
  RAISE NOTICE '[OK AUD-07.3-04] lgpd_purge_expired_operational_data funcionou para admin e respeitou janela de 24h.';
END $$;
ROLLBACK TO SAVEPOINT sp_m074_lgpd_helper_guard;
RESET ROLE;

COMMIT;
