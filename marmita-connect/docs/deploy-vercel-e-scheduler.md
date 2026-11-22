# Guia de Deploy na Vercel, Política Fail-Closed de IP (`AF-05`) e Agendador de 1 Minuto (`AF-02`)

## 1. Arquitetura de Durabilidade da Fila (`public.whatsapp_messages`)

O processamento de mensagens recebidas pela Meta WhatsApp Cloud API (`POST /api/public/whatsapp/meta-webhook`) opera em três camadas complementares para garantir que nenhuma mensagem ou eco comercial (`OK` / `OKK`) seja perdido ou fique preso em `status = 'processando'`:

1. **Persistência Transacional Pré-ACK (`status = 'aguardando'`)**:
   - Toda mensagem inbound e todo eco comercial (`OK` / `OKK`) é gravado em `public.whatsapp_messages` **antes** do retorno `HTTP 200` para a Meta. Se qualquer lane sofrer erro de banco, as lanes saudáveis são persistidas e o endpoint retorna `HTTP 500` para que a Meta reentregue apenas os itens pendentes (com deduplicação idempotente por `(company_id, message_uid)`).
2. **Processamento Imediato via `waitUntil` Oficial do Runtime Vercel (`Symbol.for("@vercel/request-context")`) + Micro-Batch (`1.200ms`)**:
   - Em `src/routes/api/public/whatsapp/meta-webhook.ts`, `extractRuntimeWaitUntil` obtém a função `waitUntil` do registrador global `Symbol.for("@vercel/request-context")` (API oficial do runtime Vercel Serverless / Fluid Compute usada por `@vercel/functions`), registrando a promise de `scheduleDrainWhatsAppQueue` para que a função continue drenando o lote após o envio do `HTTP 200`.
3. **Agendador Recorrente de 1 Minuto via Supabase `pg_cron` + `pg_net` + Supabase Vault (`scripts/setup-supabase-pg-cron-scheduler.sql`)**:
   - Como o plano **Vercel Hobby** restringe o Vercel Cron (`vercel.json`) a no máximo 1 execução por dia (`"0 3 * * *"`), a garantia operacional de drenagem **a cada 1 minuto (`* * * * *`)** é executada diretamente pelo **Supabase PostgreSQL (`pg_cron` + `pg_net`)**, que está disponível gratuitamente em todos os projetos Supabase (Free e Pro).

## 2. Implantação do Agendador de 1 Minuto (`pg_cron` + `pg_net` + Vault)

1. No painel da **Vercel** (Settings -> Environment Variables), defina `CRON_SECRET` com um segredo aleatório forte (mínimo de 32 caracteres).
2. No **SQL Editor do Supabase**, abra o arquivo `scripts/setup-supabase-pg-cron-scheduler.sql`, preencha `v_drain_url` (`https://SEU-DOMINIO.vercel.app/api/internal/whatsapp/drain-queue`) e `v_cron_secret` (o mesmo valor de `CRON_SECRET`) e execute o script.
3. O script configura automaticamente:
   - Armazenamento criptografado de `marmita_drain_queue_url` e `marmita_cron_secret` em `vault.secrets` (inacessível para `anon` e `authenticated`);
   - Função `public.recover_stuck_whatsapp_processing_leases()` (`SECURITY DEFINER`), que varre a cada minuto mensagens em `status = 'processando'` cujo `locked_until` tenha expirado, incrementando `lease_generation` e movendo-as para `'revisar'` (se atingiram o teto de tentativas) ou de volta para `'aguardando'` (para reprocessamento imediato);
   - Função `public.invoke_whatsapp_queue_drain_cron()` (`SECURITY DEFINER`), que executa a recuperação local de leases e, se houver mensagens pendentes em `'aguardando'` ou `'erro'` com `next_retry_at <= clock_timestamp()`, dispara `net.http_post` autenticado (`Authorization: Bearer <CRON_SECRET>`) para `/api/internal/whatsapp/drain-queue`;
   - Job `marmita-connect-drain-whatsapp-queue-1m` (`* * * * *` — a cada 1 minuto) e job `marmita-connect-lgpd-retention-daily` (`15 3 * * *` — expurgo diário LGPD).
4. Para verificar os agendamentos ativos no Supabase:
   ```sql
   SELECT jobid, jobname, schedule, active FROM cron.job;
   SELECT * FROM public.operational_scheduler_state WHERE task_key = 'whatsapp_queue_drain_cron';
   ```

## 3. Política Fail-Closed de Cabeçalhos de IP (`AF-05`)

Em `src/routes/api/public/whatsapp/meta-webhook.ts`, `extractTrustedClientIpKey` opera em modo **fail-closed**:

- **Na Vercel (`VERCEL="1"` / `VERCEL_ENV` definido automaticamente pela plataforma)**: confia exclusivamente em `x-vercel-forwarded-for` (injetado e higienizado pela borda da Vercel).
- **Fora da Vercel (padrão)**: `x-forwarded-for`, `x-vercel-forwarded-for`, `cf-connecting-ip` e `x-real-ip` são **ignorados por padrão** para impedir falsificação de IP pelo cliente.
- **Habilitação explícita por ambiente**:
  - `TRUST_CLOUDFLARE_IP="true"`: habilita leitura de `cf-connecting-ip` quando o tráfego passa exclusivamente pela Cloudflare;
  - `TRUST_PROXY_XFF="true"`: habilita leitura apenas do último salto (`rightmostHop`) de `x-forwarded-for` quando atrás de proxy reverso próprio;
  - `TRUST_X_REAL_IP="true"`: habilita leitura de `x-real-ip` quando injetado por proxy reverso dedicado.
- **Particionamento anti-bloqueio global**: quando nenhum cabeçalho de IP confiável está presente/habilitado, o bucket de rate limit pós-autenticação HMAC é particionado pelo identificador verificado do tenant (`ip:verified-meta:phone:<phone_number_id>` ou `ip:verified-meta:waba:<waba_id>`), evitando que o volume de uma empresa bloqueie outras empresas.
