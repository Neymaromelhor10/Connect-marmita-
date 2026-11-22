# Arquitetura Técnica — Marmita Connect (Verde&Mesa)

- **Stack Independente**: TanStack Start + React 19 + Tailwind CSS v4 + Supabase/PostgreSQL + Google Gemini API (`gemini-2.5-flash`) + Meta WhatsApp Cloud API.
- **Interpretação de Mensagens (`src/lib/interpret.server.ts`)**:
  - Tanto a colagem manual (`interpretMessage`) quanto o webhook da Meta (`/api/public/whatsapp/meta-webhook`) chamam `processIncomingMessage`.
  - Integração direta com a API oficial Google Gemini (`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`) usando `GEMINI_API_KEY` exclusivamente no servidor, `temperature: 0`, `responseMimeType: "application/json"`, `responseSchema`, validação Zod (`parsedMessageSchema`), timeout de 12s e retry com backoff exponencial.
  - Resiliência operacional: toda mensagem recebida é gravada de forma durável em `whatsapp_messages` (`status = 'processando'`) **antes** da chamada ao Gemini. Se o Gemini estiver indisponível, a mensagem permanece salva com `status = 'erro'` e pode ser reprocessada (`retryPendingMessages`) sem duplicar pedidos.
- **Regra Definitiva OK / OKK**:
  - Todo pedido recebido por mensagem ou colagem nasce com `financial_state = 'aguardando_classificacao'`, `paid = false` e `settled_by_payment = false`. A IA nunca decide pagamento ou fiado e nunca calcula valores financeiros.
  - A confirmação financeira é exclusiva da marmitaria via `"OK"` (pago na hora) ou `"OKK"` (fiado), pelo painel web (`classifyFinancialOrder`) ou por eco comercial verificado da Meta (`smb_message_echoes` -> `processVerifiedBusinessEcho`).
  - Somente pedidos do dia atual em `America/Sao_Paulo` podem ser confirmados por `OK` / `OKK`.
- **Cálculo e Imutabilidade de Preços (`public.set_order_total`)**:
  - Calcula `qty_g * price_g + qty_m * price_m + qty_p * price_p` na criação do pedido e congela `old.total` e `old.unit_price` em atualizações de status/pagamento.
- **Isolamento Multiempresa e Auditoria**:
  - RLS ativo em todas as tabelas via `public.current_company_id()`.
  - `whatsapp_connections` só é escrito pelo backend (`linkWhatsAppNumber`) após comprovar na Graph API da Meta que `phone_number_id` pertence ao `wabaId`.
  - `financial_events` possui trigger de imutabilidade (`financial_audit_immutable`) e `UNIQUE(company_id, event_id)`.
