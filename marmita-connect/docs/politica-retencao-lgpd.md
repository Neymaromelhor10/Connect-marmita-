# Política de Ciclo de Vida de Dados e Retenção LGPD — Marmita Connect (Argon 4)

## 1. Objetivo e Base Legal

Esta política documenta os controles técnicos implementados no banco PostgreSQL/Supabase (`0011`, `0016`, `0018` e `0021`) e na camada de aplicação (`src/lib/company.functions.ts`, `src/routes/_authenticated/clientes.tsx` e `src/routes/api/internal/whatsapp/drain-queue.ts`) para conformidade com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 — LGPD):

- **Art. 6º, III (Necessidade / Minimização)**: coleta restrita a nome, telefone, endereço de entrega e histórico de pedidos de marmita.
- **Art. 7º, V e X (Execução de Contrato e Exercício Regular de Direitos)**: preservação de dados identificadores enquanto houver saldo devedor (`fiado` em aberto) ou pedido aguardando confirmação financeira (`OK` / `OKK`).
- **Art. 16, I e Art. 18, IV e VI (Eliminação / Anonimização com Preservação de Obrigação Legal)**: eliminação de dados pessoais mediante solicitação do titular quando não houver pendência contratual, preservando os valores contábeis/financeiros agregados (`orders.total`, `payments.amount`, `financial_events.total`) sem vínculo reversível com o titular.

## 2. Fluxo de Solicitação e Execução de Anonimização (`AF-10`)

1. **Inspeção Prévia (`public.lgpd_inspect_customer` / `inspectCustomerLgpd`)**:
   - Exclusiva para administradores autenticados da empresa (`is_company_admin`).
   - Avalia em tempo real se o cliente possui dívida em aberto (`has_open_debt`) ou pedido pendente de classificação (`has_pending_classification`).
   - Se houver débito em aberto ou pedido pendente, libera apenas o escopo `dados_complementares`.
   - Se o saldo devedor for zero e não houver pedidos pendentes, libera os escopos `dados_complementares` e `anonimizacao_completa`.

2. **Execução Transacional (`public.lgpd_anonymize_customer` / `anonymizeCustomerLgpd`)**:
   - Exige autenticação válida, papel de operador financeiro (`financial_require_operator`) e privilégio de administrador da própria empresa (`is_company_admin`).
   - Exige token de confirmação explícita (`LGPD_CONFIRM_<customer_id>`) e protocolo/justificativa com no mínimo 3 caracteres.
   - No escopo `dados_complementares`:
     - Remove `customers.address`, `customers.notes`, `orders.notes` e `payments.notes`;
     - Substitui `whatsapp_messages.body` por `'[Conteúdo removido por solicitação LGPD]'`, limpa `profile_name` e remove campos `nome`/`motivo` de `parsed`.
   - No escopo `anonimizacao_completa`:
     - Executa toda a limpeza complementar acima;
     - Substitui `customers.name` por `'Titular Anonimizado #' || nextval('public.lgpd_anon_seq')` e `customers.phone` por número sintético sequencial (`99900...`) sem qualquer relação criptográfica ou hash com o telefone original (impedindo reversão por força bruta / rainbow tables);
     - Limpa `orders.financial_phone` e `financial_events.phone` (via flag transacional estrita `app.lgpd_redact_phone = 'on'`), mantendo intactos os valores monetários e datas contábeis.
   - Grava registro imutável na tabela `public.lgpd_lifecycle_audit` (protegida por RLS e pelo trigger `lgpd_lifecycle_audit_immutable_trg`).

## 3. Política de Retenção e Expurgo Agendado (`public.lgpd_purge_expired_operational_data`)

| Categoria de Dado | Tabela / Coluna | Prazo de Retenção Padrão | Ação após Expiração |
| :--- | :--- | :--- | :--- |
| Textos brutos de mensagens WhatsApp | `whatsapp_messages.body`, `profile_name`, `parsed` | `180 dias` (mínimo configurável: `30 dias` via `LGPD_RETENTION_DAYS`) | Redigido para `'[Texto expirado pela política de retenção LGPD]'` para mensagens sem lease ativo (`registrado`, `ignorado`, `revisar`, `erro`). |
| Observações de tentativas de pagamento | `payment_attempts.notes` | `180 dias` | `notes` limpo para `NULL` (mantendo `idempotency_key`, `amount`, `status` e `payment_id`). |
| Lançamentos financeiros e fiscais | `orders.total`, `payments.amount`, `financial_events` | `5 anos` (obrigação legal tributária/contábil — Art. 16, I da LGPD) | Valores monetários e datas preservados; telefone desvinculado em caso de anonimização do titular. |

## 4. Agendamento Automático

O endpoint interno `/api/internal/whatsapp/drain-queue` (acionado pelo Vercel Cron configurado em `vercel.json` e autenticado com `CRON_SECRET`) executa automaticamente `runScheduledLgpdRetentionPurgeIfNeeded` uma vez a cada 24 horas (ou imediatamente quando chamado com `?lgpd_purge=1`), invocando `public.lgpd_purge_expired_operational_data` e registrando a execução em `public.lgpd_lifecycle_audit`.
