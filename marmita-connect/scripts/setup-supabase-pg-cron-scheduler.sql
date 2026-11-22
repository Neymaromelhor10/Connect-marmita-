-- ============================================================================
-- MARMITA CONNECT (VERDE&MESA) — PROVISIONAMENTO DO AGENDADOR DE 1 MINUTO (AF-02)
-- Arquitetura: Supabase PostgreSQL + pg_cron + pg_net + Supabase Vault
-- ============================================================================
-- Este script configura no banco Supabase:
--   1. Extensões oficiais pg_cron, pg_net e supabase_vault;
--   2. Armazenamento protegido da URL interna de drenagem e do CRON_SECRET no
--      Supabase Vault (vault.secrets), sem jamais expor credenciais no frontend
--      ou para roles anon/authenticated;
--   3. Função SQL fail-safe public.recover_stuck_whatsapp_processing_leases()
--      (SECURITY DEFINER, restrita a service_role/postgres) que recupera no
--      próprio banco qualquer mensagem cujo lease tenha expirado em status = 'processando',
--      incrementando lease_generation e encaminhando para 'revisar' (se atingiu max_attempts)
--      ou 'aguardando' (para reprocessamento imediato);
--   4. Função SQL public.invoke_whatsapp_queue_drain_cron() (SECURITY DEFINER,
--      restrita a service_role/postgres) que executa primeiro a recuperação local de
--      leases expirados e em seguida dispara POST assíncrono via pg_net (net.http_post)
--      para /api/internal/whatsapp/drain-queue autenticado com Authorization: Bearer <CRON_SECRET>,
--      registrando o disparo em public.operational_scheduler_state;
--   5. Agendamento recorrente a cada 1 minuto ('* * * * *') no pg_cron para drenagem
--      da fila WhatsApp e agendamento diário ('15 3 * * *') para expurgo LGPD.
--
-- COMO EXECUTAR NO SUPABASE SQL EDITOR (STAGING OU PRODUÇÃO):
--   Substitua apenas os dois valores na seção 2 (URL do deploy e CRON_SECRET)
--   antes de executar este script no SQL Editor do projeto Supabase.
-- ============================================================================

BEGIN;

-- 1. Habilita extensões necessárias (disponíveis nativamente em todo projeto Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- 2. Configura os segredos operacionais protegidos no Supabase Vault (idempotente)
-- IMPORTANTE: Substitua os dois valores abaixo pelos valores reais do seu ambiente
-- antes de executar no SQL Editor do Supabase (NUNCA versione segredos reais no Git).
DO $$
DECLARE
  v_drain_url text := 'https://SEU-DOMINIO.vercel.app/api/internal/whatsapp/drain-queue';
  v_cron_secret text := 'PREENCHA_AQUI_O_MESMO_CRON_SECRET_CONFIGURADO_NA_VERCEL';
  v_existing_id uuid;
BEGIN
  IF v_cron_secret <> 'PREENCHA_AQUI_O_MESMO_CRON_SECRET_CONFIGURADO_NA_VERCEL' THEN
    SELECT id INTO v_existing_id FROM vault.secrets WHERE name = 'marmita_drain_queue_url' LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      PERFORM vault.update_secret(v_existing_id, v_drain_url, 'marmita_drain_queue_url', 'URL do endpoint interno de drenagem da fila WhatsApp');
    ELSE
      PERFORM vault.create_secret(v_drain_url, 'marmita_drain_queue_url', 'URL do endpoint interno de drenagem da fila WhatsApp');
    END IF;

    SELECT id INTO v_existing_id FROM vault.secrets WHERE name = 'marmita_cron_secret' LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      PERFORM vault.update_secret(v_existing_id, v_cron_secret, 'marmita_cron_secret', 'Segredo de autenticação do scheduler interno (CRON_SECRET)');
    ELSE
      PERFORM vault.create_secret(v_cron_secret, 'marmita_cron_secret', 'Segredo de autenticação do scheduler interno (CRON_SECRET)');
    END IF;
  END IF;
END $$;

-- 3. Função de recuperação fail-safe no banco para mensagens com lease expirado em 'processando'
--    Garante que NENHUMA mensagem permaneça presa indefinidamente em status = 'processando'
--    mesmo se uma instância serverless sofrer interrupção abrupta (cold stop / timeout).
CREATE OR REPLACE FUNCTION public.recover_stuck_whatsapp_processing_leases()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_moved_to_review integer := 0;
  v_requeued_for_retry integer := 0;
BEGIN
  IF session_user IN ('authenticated', 'anon')
     OR public.request_jwt_role() IN ('authenticated', 'anon')
     OR (SELECT auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'Acesso negado: rotina exclusiva do agendador interno (service_role/postgres)'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- 3.1. Mensagens em 'processando' com lease vencido que já atingiram o limite máximo de tentativas -> 'revisar'
  UPDATE public.whatsapp_messages m
     SET status = 'revisar',
         locked_by = NULL,
         locked_until = NULL,
         next_retry_at = NULL,
         lease_generation = coalesce(m.lease_generation, 0) + 1,
         last_error = coalesce(
           m.last_error,
           'LEASE_EXPIRADO_APOS_LIMITE_DE_TENTATIVAS: encaminhada para revisão manual pelo scheduler.'
         )
   WHERE m.order_id IS NULL
     AND m.status = 'processando'
     AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp())
     AND coalesce(m.attempts, 0) >= (5 + least(coalesce(m.manual_retry_count, 0), 3));
  GET DIAGNOSTICS v_moved_to_review = ROW_COUNT;

  -- 3.2. Mensagens em 'processando' com lease vencido abaixo do limite -> voltam para 'aguardando' com nova geração
  UPDATE public.whatsapp_messages m
     SET status = 'aguardando',
         locked_by = NULL,
         locked_until = NULL,
         next_retry_at = clock_timestamp(),
         lease_generation = coalesce(m.lease_generation, 0) + 1,
         last_error = coalesce(
           m.last_error,
           'LEASE_EXPIRADO_RECUPERADO_PELO_SCHEDULER: reenfileirada com segurança.'
         )
   WHERE m.order_id IS NULL
     AND m.status = 'processando'
     AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp())
     AND coalesce(m.attempts, 0) < (5 + least(coalesce(m.manual_retry_count, 0), 3));
  GET DIAGNOSTICS v_requeued_for_retry = ROW_COUNT;

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  RETURN jsonb_build_object(
    'moved_to_review_count', v_moved_to_review,
    'requeued_for_retry_count', v_requeued_for_retry,
    'executed_at', clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stuck_whatsapp_processing_leases() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_whatsapp_processing_leases() TO service_role;

-- 4. Função acionada a cada 1 minuto pelo pg_cron para recuperar leases expirados e disparar
--    o worker HTTP autenticado (/api/internal/whatsapp/drain-queue) via pg_net
CREATE OR REPLACE FUNCTION public.invoke_whatsapp_queue_drain_cron()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_recovery jsonb;
  v_pending_count integer := 0;
  v_drain_url text;
  v_cron_secret text;
  v_request_id bigint := NULL;
  v_result jsonb;
BEGIN
  IF session_user IN ('authenticated', 'anon')
     OR public.request_jwt_role() IN ('authenticated', 'anon')
     OR (SELECT auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'Acesso negado: rotina exclusiva do agendador interno (service_role/postgres)'
      USING ERRCODE = '42501';
  END IF;

  -- Serializa execuções simultâneas do agendador
  IF NOT pg_try_advisory_xact_lock(hashtextextended('whatsapp_queue_drain_cron_lock', 0)) THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'ALREADY_RUNNING');
  END IF;

  -- Passo 1: Recupera imediatamente no banco quaisquer leases expirados em 'processando'
  v_recovery := public.recover_stuck_whatsapp_processing_leases();

  -- Passo 2: Verifica se existem mensagens elegíveis para drenagem ('aguardando' ou 'erro' com retry vencido)
  SELECT count(*)::int
    INTO v_pending_count
    FROM public.whatsapp_messages m
   WHERE m.order_id IS NULL
     AND m.status IN ('aguardando', 'erro')
     AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp())
     AND coalesce(m.attempts, 0) < (5 + least(coalesce(m.manual_retry_count, 0), 3));

  -- Passo 3: Lê URL e segredo do Supabase Vault (ou GUC de fallback) e dispara net.http_post se houver itens elegíveis
  BEGIN
    SELECT decrypted_secret INTO v_drain_url
      FROM vault.decrypted_secrets
     WHERE name = 'marmita_drain_queue_url'
     LIMIT 1;

    SELECT decrypted_secret INTO v_cron_secret
      FROM vault.decrypted_secrets
     WHERE name = 'marmita_cron_secret'
     LIMIT 1;
  EXCEPTION
    WHEN OTHERS THEN
      v_drain_url := NULL;
      v_cron_secret := NULL;
  END;

  v_drain_url := coalesce(nullif(btrim(v_drain_url), ''), nullif(btrim(current_setting('app.settings.drain_queue_url', true)), ''));
  v_cron_secret := coalesce(nullif(btrim(v_cron_secret), ''), nullif(btrim(current_setting('app.settings.cron_secret', true)), ''));

  IF v_pending_count > 0 AND v_drain_url IS NOT NULL AND v_cron_secret IS NOT NULL THEN
    SELECT net.http_post(
      url := v_drain_url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_cron_secret,
        'x-cron-secret', v_cron_secret,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('source', 'supabase_pg_cron_1m', 'pending_count', v_pending_count),
      timeout_milliseconds := 25000
    ) INTO v_request_id;
  END IF;

  v_result := jsonb_build_object(
    'dispatched', (v_request_id IS NOT NULL),
    'pg_net_request_id', v_request_id,
    'eligible_pending_count', v_pending_count,
    'lease_recovery', v_recovery,
    'executed_at', clock_timestamp()
  );

  INSERT INTO public.operational_scheduler_state(task_key, last_executed_at, last_result)
  VALUES ('whatsapp_queue_drain_cron', clock_timestamp(), v_result)
  ON CONFLICT (task_key)
  DO UPDATE SET
    last_executed_at = EXCLUDED.last_executed_at,
    last_result = EXCLUDED.last_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_whatsapp_queue_drain_cron() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_whatsapp_queue_drain_cron() TO service_role;

-- 5. Registra os jobs no pg_cron (idempotente: remove agendamento anterior se existir)
DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job
     WHERE jobname IN (
       'marmita-connect-drain-whatsapp-queue',
       'marmita-connect-drain-whatsapp-queue-1m',
       'marmita-connect-lgpd-retention-daily'
     )
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  -- Job 1 (A cada 1 minuto): recupera leases expirados e drena a fila WhatsApp via pg_net
  PERFORM cron.schedule(
    'marmita-connect-drain-whatsapp-queue-1m',
    '* * * * *',
    $cron$SELECT public.invoke_whatsapp_queue_drain_cron();$cron$
  );

  -- Job 2 (Diário às 03:15 UTC): executa expurgo operacional LGPD de 180 dias no banco
  PERFORM cron.schedule(
    'marmita-connect-lgpd-retention-daily',
    '15 3 * * *',
    $cron$SELECT public.lgpd_purge_expired_operational_data(180, false);$cron$
  );
END $$;

COMMIT;
