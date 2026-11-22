-- Migração 0017: Nona Rodada de Correções e Hardening Pós-Oitava Auditoria Independente (Argon 4 — AUD8-02)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0016).
-- Escopo:
--   AUD8-02 (BAIXO — Hardening de Defesa em Profundidade SQL):
--     - Cria função auxiliar public.request_jwt_role() (STABLE, SECURITY INVOKER) para extrair de forma
--       confiável a role declarada no contexto JWT do PostgREST/Supabase (request.jwt.claim.role ou
--       request.jwt.claims->>'role') sem falhar caso o JSON esteja vazio ou ausente.
--     - Concede EXECUTE em public.financial_require_operator() para authenticated e service_role
--       (mantendo REVOKE para PUBLIC e anon), permitindo sua invocação segura a partir de triggers
--       SECURITY INVOKER.
--     - Refatora public.guard_whatsapp_messages_protected_fields() e public.guard_company_admin_update()
--       para SECURITY INVOKER (eliminando a avaliação incorreta de current_user = 'postgres' dentro de
--       SECURITY DEFINER) e validando simultaneamente:
--         1. current_user IN ('authenticated', 'anon')
--         2. session_user IN ('authenticated', 'anon')
--         3. public.request_jwt_role() IN ('authenticated', 'anon') (quando fora de RPC autorizada)
--         4. auth.uid() IS NOT NULL (quando fora de RPC autorizada)
--     - Reforça public.whatsapp_manual_retry_audit_immutable() (SECURITY INVOKER) para exigir, além de
--       app.allow_audit_cleanup = 'on' e current_user NOT IN ('authenticated', 'anon'), que
--       session_user NOT IN ('authenticated', 'anon'), que o banco corrente não possua marcador/nome de
--       produção e que app.environment não seja 'production'/'producao'.
--     - Preserva integralmente o REVOKE UPDATE amplo de authenticated em public.whatsapp_messages,
--       o GRANT UPDATE (status) restrito, a validação de auth.uid(), a proteção de app.whatsapp_rpc_context
--       e todas as RPCs autorizadas.

BEGIN;

-- ============================================================================
-- 1. FUNÇÃO AUXILIAR CONFIÁVEL PARA IDENTIFICAÇÃO DA ROLE JWT / POSTGREST
-- ============================================================================

CREATE OR REPLACE FUNCTION public.request_jwt_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claim_role text;
  v_raw_claims text;
BEGIN
  v_claim_role := nullif(btrim(current_setting('request.jwt.claim.role', true)), '');
  IF v_claim_role IS NOT NULL THEN
    RETURN v_claim_role;
  END IF;

  v_raw_claims := nullif(btrim(current_setting('request.jwt.claims', true)), '');
  IF v_raw_claims IS NOT NULL AND left(v_raw_claims, 1) = '{' THEN
    BEGIN
      v_claim_role := nullif(btrim((v_raw_claims::jsonb ->> 'role')), '');
    EXCEPTION
      WHEN OTHERS THEN
        v_claim_role := NULL;
    END;
  END IF;

  RETURN coalesce(v_claim_role, '');
END;
$$;

REVOKE ALL ON FUNCTION public.request_jwt_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_jwt_role() TO anon, authenticated, service_role;

-- Permite que triggers SECURITY INVOKER invoquem financial_require_operator() quando executados por authenticated
REVOKE ALL ON FUNCTION public.financial_require_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_require_operator() TO authenticated, service_role;

-- ============================================================================
-- 2. AUD8-02: HARDENING DO TRIGGER DE IMUTABILIDADE DE WHATSAPP_MANUAL_RETRY_AUDIT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.whatsapp_manual_retry_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_name text := current_database();
  v_db_comment text;
  v_app_env text := coalesce(current_setting('app.environment', true), '');
BEGIN
  -- Permite limpeza controlada exclusivamente de registros sintéticos de homologação/teste
  -- quando a variável transacional local app.allow_audit_cleanup = 'on' for definida por role privilegiada
  -- em banco que comprovadamente não seja de produção.
  IF TG_OP = 'DELETE'
     AND current_setting('app.allow_audit_cleanup', true) = 'on'
     AND current_user NOT IN ('authenticated', 'anon')
     AND session_user NOT IN ('authenticated', 'anon')
     AND v_app_env NOT ILIKE '%prod%'
     AND v_db_name NOT ILIKE '%prod%' THEN

    SELECT shobj_description(oid, 'pg_database')
      INTO v_db_comment
      FROM pg_database
     WHERE datname = v_db_name;

    IF coalesce(v_db_comment, '') NOT ILIKE '%production%'
       AND coalesce(v_db_comment, '') NOT ILIKE '%producao%' THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'Auditoria de reprocessamento manual (whatsapp_manual_retry_audit) é imutável e não pode ser alterada ou excluída'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_manual_retry_audit_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_manual_retry_audit_immutable_trg ON public.whatsapp_manual_retry_audit;
CREATE TRIGGER whatsapp_manual_retry_audit_immutable_trg
  BEFORE UPDATE OR DELETE ON public.whatsapp_manual_retry_audit
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_manual_retry_audit_immutable();

-- ============================================================================
-- 3. AUD8-02: REFATORAÇÃO DE GUARD_COMPANY_ADMIN_UPDATE PARA SECURITY INVOKER
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_company_admin_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role text := public.request_jwt_role();
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Identificador da empresa não pode ser alterado'
      USING ERRCODE = '42501';
  END IF;

  IF current_user IN ('authenticated', 'anon')
     OR session_user IN ('authenticated', 'anon')
     OR v_jwt_role IN ('authenticated', 'anon')
     OR auth.uid() IS NOT NULL THEN

    IF current_user = 'anon'
       OR session_user = 'anon'
       OR v_jwt_role = 'anon'
       OR auth.uid() IS NULL
       OR NOT public.is_company_admin(OLD.id) THEN
      RAISE EXCEPTION 'Permissão administrativa necessária para alterar configurações ou preços da empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_company_admin_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS companies_guard_admin_update ON public.companies;
CREATE TRIGGER companies_guard_admin_update
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_admin_update();

-- ============================================================================
-- 4. AUD8-02: REFATORAÇÃO DE GUARD_WHATSAPP_MESSAGES_PROTECTED_FIELDS PARA SECURITY INVOKER
-- ============================================================================

-- Preserva intactos os privilégios restritos por coluna em public.whatsapp_messages
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_messages FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_messages TO authenticated;
GRANT UPDATE (status) ON public.whatsapp_messages TO authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;

CREATE OR REPLACE FUNCTION public.guard_whatsapp_messages_protected_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  op_comp uuid;
  v_jwt_role text := public.request_jwt_role();
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Identificador da empresa (company_id) da mensagem não pode ser alterado'
      USING ERRCODE = '42501';
  END IF;

  -- Quando a atualização parte de role de cliente (authenticated/anon via current_user, session_user ou JWT)
  -- ou possui auth.uid() ativo fora de uma RPC interna autorizada (app.whatsapp_rpc_context = 'on'):
  IF current_user IN ('authenticated', 'anon')
     OR session_user IN ('authenticated', 'anon')
     OR (
       (v_jwt_role IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL)
       AND current_setting('app.whatsapp_rpc_context', true) IS DISTINCT FROM 'on'
     ) THEN

    IF current_user = 'anon'
       OR session_user = 'anon'
       OR v_jwt_role = 'anon'
       OR auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: autenticação de operador obrigatória para atualizar whatsapp_messages'
        USING ERRCODE = '42501';
    END IF;

    -- 1. Exige que o usuário autenticado seja operador autorizado da própria empresa
    BEGIN
      op_comp := public.financial_require_operator();
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'Permissão de operador necessária para atualizar mensagem do WhatsApp (%)' , SQLERRM
          USING ERRCODE = '42501';
    END;

    IF op_comp IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Acesso negado para alterar mensagem de outra empresa'
        USING ERRCODE = '42501';
    END IF;

    -- 2. Bloqueia qualquer alteração em campos de controle operacional, concorrência ou vínculo financeiro
    IF (
      NEW.attempts,
      NEW.manual_retry_count,
      NEW.last_manual_retry_at,
      NEW.last_manual_retry_by,
      NEW.lease_generation,
      NEW.locked_by,
      NEW.locked_until,
      NEW.next_retry_at,
      NEW.last_error,
      NEW.order_id,
      NEW.customer_id,
      NEW.phone,
      NEW.direction,
      NEW.source,
      NEW.message_uid,
      NEW.body,
      NEW.parsed,
      NEW.qty_g,
      coalesce(NEW.qty_m, 0),
      NEW.qty_p,
      NEW.fiado,
      NEW.order_date,
      NEW.profile_name,
      NEW.phone_number_id,
      NEW.received_at,
      NEW.created_at
    ) IS DISTINCT FROM (
      OLD.attempts,
      OLD.manual_retry_count,
      OLD.last_manual_retry_at,
      OLD.last_manual_retry_by,
      OLD.lease_generation,
      OLD.locked_by,
      OLD.locked_until,
      OLD.next_retry_at,
      OLD.last_error,
      OLD.order_id,
      OLD.customer_id,
      OLD.phone,
      OLD.direction,
      OLD.source,
      OLD.message_uid,
      OLD.body,
      OLD.parsed,
      OLD.qty_g,
      coalesce(OLD.qty_m, 0),
      OLD.qty_p,
      OLD.fiado,
      OLD.order_date,
      OLD.profile_name,
      OLD.phone_number_id,
      OLD.received_at,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Alteração direta de campos de controle operacional ou financeiro em whatsapp_messages não é permitida'
        USING ERRCODE = '42501';
    END IF;

    -- 3. Na coluna status, o cliente autenticado só pode dispensar ('ignorado') mensagem ainda não vinculada a pedido
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status <> 'ignorado'
         OR OLD.order_id IS NOT NULL
         OR OLD.status = 'registrado' THEN
        RAISE EXCEPTION 'Transição direta para o status "%" não é permitida; utilize as RPCs oficiais do sistema', NEW.status
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_whatsapp_messages_protected_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_messages_guard_client_update ON public.whatsapp_messages;
CREATE TRIGGER whatsapp_messages_guard_client_update
  BEFORE UPDATE ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_whatsapp_messages_protected_fields();

COMMIT;
