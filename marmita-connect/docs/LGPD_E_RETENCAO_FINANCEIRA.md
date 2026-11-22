# Adequação à LGPD, Anonimização Irreversível e Estratégia de Restauração Supabase Auth

Este documento descreve a arquitetura técnica e jurídica implementada na migração `0011_pre_production_hardening.sql` e nos scripts operacionais do **Marmita Connect (Verde&Mesa)**.

---

## 1. Base Legal (Lei nº 13.709/2018 — LGPD)

1. **Execução de contrato e procedimentos preliminares (Art. 7º, V da LGPD)**:
   - O tratamento do nome, telefone de contato, endereço de entrega e mensagens de pedidos enviadas via WhatsApp ocorre estritamente para preparar, entregar e cobrar as marmitas solicitadas pelo cliente.
2. **Cumprimento de obrigação legal, fiscal e contábil (Art. 7º, II e Art. 16, I da LGPD c/c Art. 173 do CTN)**:
   - Os valores monetários de vendas (`orders.total`, `qty_p`, `qty_m`, `qty_g`), recebimentos (`payments.amount`, `paid_at`) e eventos da trilha de auditoria financeira (`financial_events`) são retidos pelo prazo legal de **5 anos** para integridade contábil e fiscal da marmitaria, desvinculados de identificadores pessoais quando solicitada a anonimização.

---

## 2. Diferenciação Técnica: Anonimização Real vs. Pseudonimização

### Por que um hash SHA-256 de telefone NÃO é anonimização
O espaço de telefones celulares brasileiros possui apenas **11 dígitos** (`DDD` + `9` + `8 dígitos`, menos de $10^9$ combinações possíveis). Um hash determinístico (`SHA-256(telefone)` ou mesmo com salt fixo por empresa) permite reversão trivial por força bruta (*rainbow table*) em poucos segundos. Portanto, substituir o telefone por um hash determinístico constitui apenas **pseudonimização** (Art. 13, § 4º da LGPD), mantendo o dado sujeito à LGPD.

### Como o Marmita Connect implementa Anonimização Real Irreversível
A função `public.lgpd_anonymize_customer_pii(_customer_id, _mode, _reason)` utiliza uma sequência monotônica global (`public.lgpd_anon_seq`) sem qualquer relação matemática com o nome, telefone ou texto original do titular:
- `customers.name` $\rightarrow$ `'Cliente Anonimizado #' || nextval('public.lgpd_anon_seq')`
- `customers.phone` $\rightarrow$ `'000' || lpad(seq::text, 8, '0')` (identificador sintético único de 11 dígitos que satisfaz `idx_customers_company_phone_key` sem colidir e sem derivar do telefone real).

---

## 3. Inventário Completo de Campos PII Limpos na Anonimização

A RPC `public.lgpd_anonymize_customer_pii` limpa todos os campos onde dados pessoais poderiam residir:

| Tabela | Coluna / Campo JSON | Tratamento em `dados_complementares` | Tratamento em `anonimizacao_completa` |
| :--- | :--- | :--- | :--- |
| `public.customers` | `name` | Mantido | Substituído por `'Cliente Anonimizado #<seq>'` |
| `public.customers` | `phone` | Mantido | Substituído por `'000<seq_8_digitos>'` (sintético irreversível) |
| `public.customers` | `address` | `NULL` | `NULL` |
| `public.customers` | `notes` | `NULL` | `NULL` |
| `public.whatsapp_messages` | `phone` | Mantido | Substituído por `'000<seq_8_digitos>'` |
| `public.whatsapp_messages` | `profile_name` | `NULL` | `NULL` |
| `public.whatsapp_messages` | `body` | `'[conteúdo removido — LGPD]'` | `'[conteúdo removido — LGPD]'` |
| `public.whatsapp_messages` | `parsed->>'nome'` e `parsed->>'motivo'` | Removidos (`parsed - 'nome' - 'motivo'`) | Removidos (`parsed - 'nome' - 'motivo'`) |
| `public.orders` | `notes` | `NULL` | `NULL` |
| `public.orders` | `financial_phone` | Mantido | `NULL` |
| `public.payments` | `notes` | `NULL` | `NULL` |
| `public.financial_events` | `phone` | Mantido | `NULL` |

### Validação Prévia de Pendências (`public.lgpd_inspect_customer`)
Antes de executar a anonimização, a RPC `public.lgpd_inspect_customer(_customer_id)` calcula:
- `open_fiado_balance`: saldo devedor líquido em aberto (`total fiado - total pagamentos`).
- `awaiting_orders_count`: quantidade de pedidos do cliente ainda em `aguardando_classificacao`.
- `can_anonymize_full`: `true` somente quando `open_fiado_balance = 0` e `awaiting_orders_count = 0`.
- Enquanto houver dívida em aberto ou pedido pendente de classificação, o modo `'anonimizacao_completa'` é bloqueado com erro explícito, permitindo apenas `'dados_complementares'` (que expurga endereço, observações, nome de perfil e textos brutos de mensagens sem inviabilizar a cobrança contratual legítima).

### Expurgo Periódico de Textos Brutos (`public.lgpd_purge_expired_message_bodies`)
A função `public.lgpd_purge_expired_message_bodies(_company_id, _retention_days DEFAULT 180)` substitui `body` por `'[expurgado por política de retenção]'`, zera `profile_name` e remove `parsed->>'nome'` e `parsed->>'motivo'` de todas as mensagens já processadas (`status IN ('registrado', 'ignorado')`) com mais de 180 dias.

---

## 4. Estratégia Realista de Backup e Restauração do Ambiente Supabase (Incluindo Auth/GoTrue)

A simples cópia das tabelas `auth.users` e `auth.identities` não é suficiente para restaurar um ambiente Supabase funcional. O procedimento completo implementado em `scripts/backup-database.sh` e `scripts/verify-restore-drill.sh` cobre todas as dependências do GoTrue:

### 4.1. O que é exportado no mesmo Snapshot (`pg_export_snapshot()`)
1. **Schema `auth` completo (`marmita_auth.dump`)**:
   - `auth.users` (hashes bcrypt/argon2 em `encrypted_password`, metadados, confirmações)
   - `auth.identities` (vínculos OAuth Google e email)
   - `auth.refresh_tokens`, `auth.sessions`, `auth.mfa_factors`, `auth.mfa_challenges`, `auth.mfa_amr_claims`, `auth.flow_state`, `auth.one_time_tokens`, `auth.schema_migrations` e `auth.instances`.
2. **Schema `public` completo (`marmita_public.dump`)**:
   - Todas as tabelas de negócio (`companies`, `profiles`, `user_roles`, `financial_permissions`, `customers`, `orders`, `payments`, `payment_attempts`, `financial_events`, `whatsapp_connections`, `whatsapp_messages`), triggers, constraints deferrable e RPCs.
3. **Manifesto transacional (`manifest.json`)**:
   - Extraído sob `SET TRANSACTION SNAPSHOT` com o mesmo identificador do `pg_dump`, garantindo zero divergência mesmo sob escrita concorrente.

### 4.2. Dependências de Configuração do Supabase Auth no Ambiente Restaurado
Para que o login funcione imediatamente após a restauração em um novo projeto Supabase ou instância GoTrue auto-hospedada:
1. **`GOTRUE_JWT_SECRET` (`JWT Secret`)**:
   - Se o novo ambiente configurar o mesmo `GOTRUE_JWT_SECRET` do ambiente original (armazenado no cofre de segredos da infraestrutura), os JWTs e `refresh_tokens` ativos continuam válidos sem exigir novo login.
   - Caso um novo `GOTRUE_JWT_SECRET` seja utilizado, os usuários existentes autenticam normalmente com email/senha (`auth.users.encrypted_password` é um hash bcrypt independente do `JWT_SECRET`) ou Google OAuth (`auth.identities`), emitindo novos tokens.
2. **Provedor Google OAuth**:
   - Configurar `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`, `GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID`, `GOTRUE_EXTERNAL_GOOGLE_SECRET` e adicionar a URL de callback (`https://<novo-projeto>.supabase.co/auth/v1/callback`) no Google Cloud Console.
3. **Validação Automatizada no Restore Drill (`scripts/verify-restore-drill.sh`)**:
   - Verifica `orphan_profiles = 0` (`public.profiles` $\leftrightarrow$ `auth.users`).
   - Simula sessão JWT autenticada (`request.jwt.claim.sub`) validando `public.current_company_id()` e políticas RLS.
   - Quando `RESTORE_TEST_GOTRUE_URL` está configurado no ambiente de staging, executa login real via `POST /auth/v1/token?grant_type=password` e valida o `HTTP 200` com emissão de `access_token`.
