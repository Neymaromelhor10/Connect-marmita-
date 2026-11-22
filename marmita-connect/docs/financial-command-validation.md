# Preparação financeira OK / OKK — 26/10/2026

## Resultado: PARCIAL — confirmação automática desativada

Preparado um avaliador puro e desconectado do aplicativo. Não recebe chamadas do webhook, não chama a IA, não consulta ou grava no banco e não autoriza qualquer alteração financeira real. Não houve migração, alteração visual, envio de WhatsApp ou publicação.

## Testes efetivamente executados

Comando: `bunx vitest run src/lib/financial-command.test.ts`.

- 58 casos locais executados uma vez, todos aprovados.
- Tempo de testes: 23 ms; duração total do executor: 195 ms. Estes tempos **não são** tempos de resposta da produção.
- OK solicita PAGO e OKK solicita FIADO no mesmo pedido, preservando o valor concreto R$174 e sem modificar a entrada.
- Bloqueios testados: comandos não exatos, cliente, origem desconhecida, funcionário não autorizado, metadados ausentes, citações, encaminhamentos, evento duplicado, contexto conflitante, pedido antigo, cancelado, classificado, parcialmente pago, valor inválido e múltiplos candidatos.
- Verificados o dia brasileiro em 23:59:59, 00:00:00 e 00:00:01 e o bloqueio após a virada local.
- Log de compilação observado após os arquivos adicionados: build OK.

## Limites e não testado

- As identidades e autorizações nos testes são entradas simuladas, não prova de permissões de produção. O adaptador futuro deve derivá-las exclusivamente no servidor.
- Não há novo estado pendente aplicado ao banco. Não há auditoria persistente ou transação de classificação implementada.
- Não testados: pagamentos reais, concorrência transacional, bloqueios do banco, regressão integrada de saldos/FIFO, recebimento de mensagens empresariais da Meta, persistência e fluxo completo pela interface.
- O teste de evento repetido valida apenas a decisão com histórico fornecido. Não comprova deduplicação concorrente persistente.
- Nenhum pedido existente é convertido em pendente. Os fluxos atuais permanecem intactos.

## Bloqueios para continuar

1. Decisão sobre quais novos pedidos podem ficar aguardando classificação em vez da regra atual pago/fiado.
2. Prova de origem empresarial (`smb_message_echoes` ou entrada autenticada aprovada) e política de funcionários autorizados. Mensagem de cliente nunca comprova confirmação da marmitaria.
3. Ambiente separado comprovado ou autorização específica para testes integrados gravando no banco publicado.

Os comandos continuam desativados até resolver essas dependências e implementar/validar a transação auditável; estes 58 testes não certificam o financeiro em produção.