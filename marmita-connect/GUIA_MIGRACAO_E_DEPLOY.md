# Guia de Migração, Configuração e Deploy Independente — Marmita Connect (Verde&Mesa)

Este documento detalha o plano completo de engenharia para operar o **Marmita Connect** de forma 100% independente do Lovable Cloud, sob suas próprias contas do **Supabase**, **Google AI Studio (Gemini API)**, **Meta for Developers (WhatsApp Cloud API)** e hospedagem própria, incluindo o pacote completo de **Hardening de Pré-Produção (`0011_pre_production_hardening.sql`)**.

---

## 1. Inventário de Dependências do Lovable Cloud Eliminadas (Fase A)

Todas as 10 dependências diretas e indiretas do Lovable Cloud foram removidas do código:

| Item Encontrado no Código Original | Onde Estava | Solução Implementada |
| :--- | :--- | :--- |
| **1. Lovable AI Gateway (`https://ai.gateway.lovable.dev/v1/chat/completions`) + `LOVABLE_API_KEY`** | `src/lib/interpret.server.ts` | Substituído pela chamada direta à API oficial do Google Gemini (`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`) usando `GEMINI_API_KEY` no backend, `temperature: 0`, `responseSchema` JSON, validação Zod, timeout (10s) e retry com backoff exponencial. |
| **2. SDK de OAuth `@lovable.dev/cloud-auth-js` (`lovable.auth.signInWithOAuth`)** | `package.json`, `src/integrations/lovable/index.ts`, `src/routes/index.tsx` | Pacote e arquivo removidos. Substituídos pelo OAuth nativo do Supabase (`supabase.auth.signInWithOAuth({ provider: "google" })`). |
| **3. Broker de sessão `previewAuthStorage.ts` (`lovable-preview-auth:*`)** | `src/integrations/supabase/previewAuthStorage.ts`, `client.ts` | Arquivo removido. O cliente Supabase no navegador agora usa `window.localStorage` padrão com `detectSessionInUrl: true`. |
| **4. Telemetria do Editor (`lovable-error-reporting.ts` / `window.__lovableEvents`)** | `src/lib/lovable-error-reporting.ts`, `src/routes/__root.tsx` | Arquivo removido e importação limpa em `__root.tsx`. |
| **5. Wrapper de Build `@lovable.dev/vite-tanstack-config`** | `package.json`, `vite.config.ts` | Substituído pela configuração padrão oficial do Vite com `@tanstack/react-start/plugin/vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` e `vite-tsconfig-paths`. |
| **6. Variáveis exclusivas `LOVABLE_DB_MIGRATION_URL` e `LOVABLE_CRON_SECRET`** | `drizzle.config.ts`, `src/integrations/supabase/cron-auth.ts` | Substituídas por `DATABASE_URL` / `SUPABASE_DB_URL` e `CRON_SECRET`. |
| **7. ID de projeto hardcoded `ehsmkjuelryvoqyweiga`** | `supabase/config.toml` | Substituído por identificador neutro configurável (`marmita-connect`). |
| **8. Lockfile `bun.lock` apontando para cache privado GCP (`europe-west*-npm.pkg.dev/lovable-core-prod/...`)** | `bun.lock`, `bunfig.toml` | Removido o `bun.lock` preso ao registry interno da Lovable e limpo o `bunfig.toml`, permitindo `npm install` ou `bun install` diretamente do registry oficial `https://registry.npmjs.org`. |

---

## 2. Configuração do Projeto Supabase Próprio e Migração de Dados (Fase B)

### 2.1. Criação e Aplicação do Schema Completo (`0000` a `0011`)
Em um banco novo, aplique o script consolidado `docs/sql/supabase-complete-schema-0000-to-0011.sql` que executa na ordem exata todas as 12 migrações (`0000` a `0011`, incluindo o hardening financeiro, fila durável, idempotência de pagamentos, telefones e LGPD):

```bash
# Opção A: Aplicando o arquivo consolidado único em um projeto Supabase novo
psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/sql/supabase-complete-schema-0000-to-0011.sql

# Opção B: Aplicando arquivo por arquivo na ordem 0000 -> 0011
for f in drizzle/migrations/0*.sql; do
  echo "Aplicando $f..."
  psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

### 2.2. Backup Automatizado Coordenado (`pg_export_snapshot()`) e Restore Drill
Utilize os scripts em `scripts/backup-database.sh` e `scripts/verify-restore-drill.sh` (automatizados diariamente via `.github/workflows/database-backup.yml`):

```bash
# 1. Executar backup consistente com snapshot transacional coordenado (public + auth + manifest.json)
DATABASE_URL="$DATABASE_URL" ./scripts/backup-database.sh

# 2. Executar exercício de restauração e validação em banco isolado de staging
RESTORE_TEST_DATABASE_URL="$STAGING_DATABASE_URL" ./scripts/verify-restore-drill.sh ./backups/<TIMESTAMP>
```

### 2.3. Configuração do Google Login no Seu Supabase Próprio
1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), crie um **OAuth 2.0 Client ID** (Web application).
2. Adicione em **Authorized redirect URIs**:
   `https://<SEU_PROJETO_ID>.supabase.co/auth/v1/callback`
3. No painel do seu projeto Supabase (**Authentication -> Providers -> Google**), ative o provedor Google e cole o `Client ID` e o `Client Secret`.
4. Em **Authentication -> URL Configuration**, defina:
   * **Site URL**: `https://seu-dominio.com.br`
   * **Redirect URLs**: `https://seu-dominio.com.br/**` e `http://localhost:3000/**`

---

## 3. Configuração da Google Gemini API Direta (Fase C)

1. Acesse o [Google AI Studio](https://aistudio.google.com/apikey) com sua conta Google e gere uma chave de API.
2. Configure no servidor a variável de ambiente secreta:
   ```env
   GEMINI_API_KEY="AIzaSy..."
   ```
3. **Nunca** adicione o prefixo `VITE_` à `GEMINI_API_KEY`. Ela é lida exclusivamente em `src/lib/interpret.server.ts` no servidor.

---

## 4. Configuração da Meta WhatsApp Cloud API e Worker de Fila Durável (Fase D)

1. No painel [Meta for Developers](https://developers.facebook.com/), abra seu App WhatsApp Business.
2. Configure no servidor as variáveis:
   * `WHATSAPP_APP_SECRET`: Chave secreta do aplicativo (**App Settings -> Basic -> App Secret**), usada para validar a assinatura `X-Hub-Signature-256`.
   * `WHATSAPP_VERIFY_TOKEN`: String secreta definida por você para validar o `GET` do webhook.
   * `WHATSAPP_ACCESS_TOKEN`: Token permanente de System User (**Business Settings -> System Users**) com permissão `whatsapp_business_management`.
   * `CRON_SECRET`: Segredo de 32 bytes para autenticar o worker de drenagem da fila (`POST /api/internal/whatsapp/drain-queue`).
3. Em **WhatsApp -> Configuration -> Webhook**, aponte a Callback URL para:
   `https://seu-dominio.com.br/api/public/whatsapp/meta-webhook`
4. Configure o agendador de 1 minuto (Cron da plataforma ou `pg_cron` + `pg_net` no Supabase) para chamar:
   * `POST https://seu-dominio.com.br/api/internal/whatsapp/drain-queue`
   * Header: `Authorization: Bearer <CRON_SECRET>`
5. Configure o monitoramento de saúde externo (UptimeRobot / BetterStack) apontando para:
   * `GET https://seu-dominio.com.br/api/public/health`
