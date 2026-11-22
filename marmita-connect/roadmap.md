# Confirmação financeira OK / OKK — Status Atualizado

- [x] Exportar código-fonte em ZIP limpo, sem segredos, dependências, builds ou metadados do repositório.
- [x] Avaliador conservador (`src/lib/financial-command.ts`) e 58 testes unitários preservados.
- [x] Suporte aos tamanhos P, M e G na tabela de preços, pedidos, mensagens, relatórios e extração com IA.
- [x] Regra definitiva implementada em `src/lib/interpret.server.ts`: todos os pedidos recebidos por mensagem ou colagem manual nascem obrigatoriamente com `financial_state = 'aguardando_classificacao'`, `paid = false` e `settled_by_payment = false` (a IA nunca decide pagamento ou fiado).
- [x] Bloqueio de comandos `OK` / `OKK` enviados por clientes (`ORIGEM_NAO_AUTORIZADA`).
- [x] Suporte a ecos comerciais da marmitaria (`smb_message_echoes`) no webhook da Meta (`src/routes/api/public/whatsapp/meta-webhook.ts` e `src/lib/whatsapp-webhook.server.ts`) acionando `evaluateFinancialCommand` + transação de banco, encaminhando casos com múltiplos pedidos no dia para revisão (`MULTIPLOS_PEDIDOS_ELEGIVEIS`).
- [x] Botões `"OK · Pago"` e `"OKK · Fiado"` na tela de Pedidos (`src/routes/_authenticated/pedidos.tsx`) com filtro e contador de pedidos aguardando confirmação, além das 3 opções explícitas na criação manual.
- [x] Dashboard (`src/routes/_authenticated/painel.tsx`) separado nas 4 áreas: Indicadores gerais, Vendas pagas (`OK`), Vendas fiadas (`OKK`) e Pedidos aguardando confirmação.
- [x] Migrações SQL `0009` e `0010` preparadas em `drizzle/migrations/` sem depender de `CREATE ROLE ... BYPASSRLS`.
- [x] 30 cenários obrigatórios validados na suíte de testes (`src/lib/financial-activation.test.ts`).
- [ ] Aplicar migrações `0009` e `0010` no banco publicado (Supabase / Lovable Cloud).
- [ ] Configurar assinatura do campo `smb_message_echoes` no painel Meta Developers e validar o envio de eco real do WhatsApp Business App em coexistência.
