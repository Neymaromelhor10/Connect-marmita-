# Infraestrutura financeira OK / OKK — relatório de preparação

## Resultado: PARCIAL, não ativado

Código de preparação implementado e SQL validado em PostgreSQL temporário local. **Nenhuma migração foi aplicada ao Lovable Cloud publicado.** Não houve gravação de teste na produção, publicação, chamada à IA, envio de WhatsApp, alteração de autenticação/configurações ou conexão dos comandos ao webhook.

## Arquivos

Criados:
- `src/lib/financial-state.ts`: fórmula de saldo pura; pendentes explícitos excluídos, legado inalterado.
- `src/lib/financial-state.test.ts`: 9 regras de saldo.
- `src/lib/financial-persistence.ts`: orquestração do avaliador existente e persistência.
- `src/lib/financial.functions.ts`: operações autenticadas propostas de criação pendente, classificação e entrega, sem chamadores conectados.
- `tests/financial-database.test.ts`: 29 testes reais de PostgreSQL com identidades sintéticas e socket local fixo.
- `docs/sql/financial-infrastructure.proposed.sql`: proposta fora do histórico executável.
- Este relatório e plano arquivado em `.lovable/plan/`.

Alterados:
- `src/lib/queries.ts`: reutiliza fórmula pura e aceita campo financeiro opcional, compatível com banco sem migração.
- `src/routes/_authenticated/relatorios.tsx`: detalhe/CSV não confunde pendência com fiado; layout preservado.
- `vitest.config.ts`: inclui testes separados do aplicativo.
- `AGENTS.md` e `roadmap.md`: arquitetura e pendências.

`src/lib/financial-command.ts` e seus 58 testes foram preservados. Webhook, interpretação/IA, preços atuais, criação manual de vendas e clientes não foram modificados. O arquivo antigo `docs/financial-command-validation.md` documenta a fase anterior, não esta infraestrutura.

## Operações e proposta SQL

- Capacidade optante de criar novo pedido aguardando classificação: quantidades explícitas, total pelo gatilho existente e contexto interno de operador derivado do cliente. Não converte as entradas atuais de vendas em pendentes.
- Classificação de pedido existente OK=pago na hora, OKK=fiado; sem inserir venda ou pagamento e sem reclassificar pedidos legados.
- Contexto carregado pelo banco a partir de sessão, empresa, permissão financeira específica, cliente/pedido e data brasileira. O avaliador real participa da orquestração; a transação revalida condições sob bloqueio.
- Idempotência por evento/empresa e criação/empresa; bloqueios de cliente e pedido, eventos persistentes e proteção de escrita direta para novos registros financeiros.
- FIFO continua com a fórmula legada, excluindo pendentes. Baixa de novo fiado usa `settled_by_payment`, mantendo compatibilidade de saldo.
- Atualizações de status não recalculam preço do pedido; ajuste limitado ao gatilho proposto, sem UPDATE em linhas históricas.
- Auditoria somente leitura para usuários, sem cascatas de exclusão; nova estrutura de permissões começa vazia na produção.

**SQL preparado, não aplicado na produção:** `docs/sql/financial-infrastructure.proposed.sql`. Ele foi executado apenas no PostgreSQL temporário. Nenhum novo arquivo foi colocado em `drizzle/migrations`, e os tipos gerados do banco não foram editados. Funções novas falham fechadas se a infraestrutura não existe.

## Evidências de teste

Banco temporário iniciado pela instalação completa do PostgreSQL 17.9, após falha do executável abreviado ao localizar biblioteca. Prova: diretório `/tmp/financial-isolation/pg`, conexão Unix socket, endereço IP do servidor nulo e zero tabelas públicas antes da preparação. Nenhuma credencial real foi usada. Os testes também exigem zero empresas antes de gerar suas próprias linhas.

Última rodada completa:

```text
FINANCIAL_LOCAL_DB_TESTS=1 bunx vitest run src/lib/financial-command.test.ts src/lib/financial-state.test.ts tests/financial-database.test.ts
58 testes avaliador: 22 ms
9 testes saldo: 4 ms
29 testes PostgreSQL: 195 ms
96 aprovados; 3 arquivos; duração total 332 ms
```

Tempos são locais, não desempenho publicado. Rodadas intermediárias encontraram erro do executor ao usar BEGIN fora de conexão reservada e grant ausente para `current_company_id` no proprietário dedicado do FIFO. Ambos foram corrigidos somente na preparação; a rodada final passou.

Os 29 testes executam funções e gatilhos SQL reais: R$174 preservados; uma venda e zero pagamentos por classificação; pendência; histórico sintético idêntico antes/depois do SQL; repetição/conflitos; duas classificações simultâneas; pagamentos simultâneos; corrida pagamento/classificação e cancelamento/classificação; FIFO legado e novo fiado; parcial R$40; isolamento A/B; permissões explícitas; escrita direta bloqueada; auditoria; preço posterior alterado. A orquestração usa `classifyWithPersistence` e `evaluateFinancialCommand` reais.

**Não testado:** transporte HTTP das server functions, autenticação hospedada real, ativação na interface, permissões do ambiente hospedado para CREATE ROLE/BYPASSRLS, integração Meta, restauração publicada, alto volume ou fuzzing extensivo. Identidades do banco são simulação local de `auth.uid()`, não login hospedado. Não houve teste pela interface publicada.

## Efeitos e reversão antes de futura autorização

Colunas anuláveis sem default preservam o significado histórico; não há backfill. Grants/RLS adicionados apenas às estruturas novas; as políticas atuais são preservadas. O SQL propõe proprietário dedicado NOLOGIN/BYPASSRLS com privilégios de tabelas e funções específicos: **sua criação pode não ser permitida no ambiente hospedado**, ainda não verificado. Não aplicar sem revisar esse requisito e autorizar separadamente.

Antes da aplicação, registrar definições anteriores de gatilhos/FIFO e verificar a proposta final. Se nenhum novo registro financeiro existe, desativar chamadores e restaurar funções anteriores, mantendo tabelas/colunas adicionais inativas. Se já existirem pendentes, não restaurar o FIFO antigo: conservar sua exclusão e auditoria, parar novas classificações e pedir procedimento específico. Não apagar tabelas ou dados nem reclassificar histórico. Reversão publicada também exige autorização.

## Limitações restantes

- A proposta não está disponível no banco publicado; novo módulo não está ativo.
- Ninguém recebeu permissão financeira real; política e provisionamento dependem de aprovação.
- Contexto `operator:empresa:cliente` representa operação interna autenticada, não conversa/eco Meta comprovado. Não reutilizar como prova de mensagem enviada pelo negócio.
- Os controles históricos de pedido continuam intactos; o caminho de entrega proposto não está conectado às telas. Antes de habilitar pendentes visíveis, conectar/guardar controles para não oferecer uma alteração direta bloqueada pelo banco e mostrar sua situação financeira adequadamente, sem redesenho.
- A classificação bloqueia crédito/parcial não rastreável em vez de inventar distribuição.
- Auditoria não registra tentativas rejeitadas antes de identificar/autorizar a empresa; conflitos de reutilização de chave retornam conflito sem sobrescrever evento original.
- Corridas com edição direta de pedidos legados e criação de vendas pelo caminho atual não foram endurecidas globalmente; os novos registros financeiros são imutáveis nos vínculos/valores e usam os caminhos restritos. Não é certificação de todo o financeiro histórico.
- Banco, pedidos, pagamentos, clientes e configurações publicados ficaram intactos por ausência de qualquer chamada de escrita. Não foi feita comparação de todas as linhas reais nem restauração de produção.

**Módulo não pronto:** aplicação autorizada, permissões hospedadas e testes integrados/Meta continuam pendentes.