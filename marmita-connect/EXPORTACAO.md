# Código-fonte do Marmita Connect

Exportação do estado atual, incluindo a preparação financeira OK/OKK.

- Sem segredos, arquivo .env, dados do banco, dependências ou arquivos compilados.
- Instale as dependências com `bun install` e inicie com `bun run dev` após configurar seu ambiente seguro.
- Esta exportação não é uma cópia do banco nem inclui credenciais dos serviços conectados.
- O SQL em `docs/sql/financial-infrastructure.proposed.sql` é somente proposta; NÃO foi aplicado à produção e não deve ser executado sem revisão e autorização específica.
- As migrações existentes representam o histórico do projeto; não reaplique sobre um banco já configurado.
- O relatório `docs/financial-infrastructure-validation.md` detalha arquivos, operações, testes e limitações.
- Última execução integrada local registrada: 96 testes aprovados, com 29 testes PostgreSQL e identidades sintéticas. Na última repetição sem banco temporário, 67 testes passaram e 29 foram pulados deliberadamente.
- O módulo financeiro não está pronto para produção: aplicação autorizada, permissões hospedadas, entradas de pendência e integração Meta continuam pendentes.
