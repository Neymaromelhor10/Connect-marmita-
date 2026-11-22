# Marmita Connect (Verde&Mesa)

SaaS de gestão para marmitarias com recebimento de pedidos via WhatsApp Cloud API (Meta), extração estruturada com Google Gemini (`gemini-2.5-flash`), confirmação financeira pela marmitaria (`OK` / `OKK`), controle de Contas a Receber (Fiado) com baixa FIFO parcial/total e Dashboard em tempo real.

## Stack Tecnológica (Infraestrutura 100% Independente)

- **Frontend & SSR / Server Functions**: TanStack Start + React 19 + Tailwind CSS v4
- **Banco de Dados & Autenticação**: Supabase (PostgreSQL + Supabase Auth + RLS + RPCs `SECURITY DEFINER`)
- **Inteligência Artificial**: Google Gemini API oficial (`gemini-2.5-flash` via `GEMINI_API_KEY`)
- **Mensageria**: Meta WhatsApp Cloud API (`messages` + `smb_message_echoes` com validação HMAC-SHA256)
- **Testes**: Vitest (109 testes automatizados + 29 testes de integração PostgreSQL)

## Como Executar Localmente

1. Instale as dependências (com Node.js 20+ ou Bun):
   ```sh
   npm install
   # ou: bun install
   ```
2. Copie `.env.example` para `.env` e preencha suas credenciais do Supabase, Google Gemini e Meta:
   ```sh
   cp .env.example .env
   ```
3. Aplique o schema completo (`0000` a `0010`) no seu banco Supabase:
   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/sql/supabase-complete-schema-0000-to-0010.sql
   ```
4. Inicie o servidor de desenvolvimento:
   ```sh
   npm run dev
   ```
5. Execute a suíte de testes e verificação de tipos:
   ```sh
   npm test
   npm run typecheck
   ```

Consulte `GUIA_MIGRACAO_E_DEPLOY.md` para o passo a passo completo de migração de dados, exportação de usuários do Supabase Auth, configuração do Google Login, configuração da Meta e deploy em produção com zero downtime.
