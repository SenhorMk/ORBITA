# Reconciliação financeira (PRE-002)

Para quem opera o Financeiro quando o Bling não confirmou uma criação de conta a
pagar ou uma quitação, ou quando o ORBITA ainda não registrou o que o Bling já
tem.

## O que aparece

Na aba Financeiro, o quadro **"Operações com resultado ainda não concluído"**
lista cada operação com uma pendência:

| Pendência na tela | O que aconteceu | Ação |
|---|---|---|
| lançamento não confirmado | a criação no Bling não teve resposta conclusiva | **Conferir no Bling** |
| confirmada no Bling, registro no ORBITA pendente | o Bling tem a conta, o título local não foi gravado/vinculado | **Conferir no Bling** (repara o título) |
| quitação não confirmada | a baixa no Bling não teve resposta conclusiva | **Conferir no Bling** |
| quitada no Bling, registro no ORBITA pendente | a baixa foi confirmada, o título local continua aberto | **Conferir no Bling** (marca pago) |
| quitação pedida no lançamento ainda não feita | o lançamento pediu "pago", a criação só se confirmou depois | **Quitar no Bling** |
| quitação recusada pelo Bling | a baixa do ORBITA foi recusada; a conta continua em aberto | quitar pelo próprio Bling e **Conferir no Bling** |
| registro local inconsistente | o título vinculado não está na organização, tem situação desconhecida ou foi cancelado com quitação em jogo | correção administrativa; nenhuma ação automática |

A lista é decidida no banco sobre todas as operações da organização. Quando há
mais pendências do que a tela mostra (100), ela diz quantas ficaram de fora.

Não existe botão de lançar de novo: o efeito pode ter acontecido.

## O que "Conferir no Bling" faz

Só lê o Bling (`GET /contas/pagar`, `GET /contas/pagar/{id}`, `GET /borderos/{id}`)
e grava um recibo em `reconciliacoes_conta_pagar` com quem conferiu, quando, o
método, o resultado e a conta remota. Desfechos:

| Tela | Significado | O que fazer |
|---|---|---|
| Confirmada no Bling e registrada no ORBITA | prova inequívoca; título gravado e vinculado uma vez | nada |
| Confirmada no Bling, mas o registro no ORBITA ainda não foi concluído | o Bling está resolvido, o título local não | conferir de novo; a operação continua listada |
| Ainda pendente | o Bling não respondeu por completo (timeout, 429, 5xx, listagem incompleta) | conferir de novo em instantes |
| Revisão manual necessária | não há prova automática (busca vazia, vários candidatos, dados divergentes, conta aberta, conta paga sem borderô do ORBITA) | conferir no próprio Bling |

"Busca vazia" não significa que a conta não existe. Conta paga não significa que
a quitação do ORBITA aconteceu: pode ter sido paga por outra pessoa.

## Revisão manual: saídas auditáveis

- **A conta existe no Bling** (criação): informe o número dela em "Nº no Bling" e
  clique **Confirmar esta conta**. O servidor lê a conta e só aceita se valor,
  vencimento, emissão e fornecedor baterem e se ela não pertencer a outra
  operação. Se a conta traz a referência desta operação, isso é evidência
  (`confirmacao_manual`). Se não traz, campos iguais NÃO provam que seja ela —
  uma conta independente pode ser idêntica: a tela pede que você marque
  **"Declaro que conferi no Bling que esta conta é a desta operação"** e confirme
  de novo. O vínculo é gravado como declaração sua (`declaracao_do_operador`),
  nunca como prova automática. Conta divergente é recusada mesmo com a
  declaração.
- **Conta paga sem prova de autoria** (baixa): confira no Bling quem lançou o
  pagamento. O ORBITA não atribui a quitação a si mesmo nem envia outra baixa.
- **Quitação recusada**: a recusa do Bling é definitiva e o ORBITA não reenvia.
  Quite pelo próprio Bling e clique **Conferir no Bling**: com a conta paga e
  saldo zerado, o título passa a pago e o recibo registra `quitada_sem_autoria`
  (pagamento confirmado, sem atribuí-lo ao ORBITA). Paga sem saldo informado
  não marca nada.
- **Nenhuma conta encontrada**: a operação continua pendente. Ver limite abaixo.

## Quitar no Bling

Só aparece quando o lançamento pediu a quitação e ela nunca foi enviada. O
servidor lê a conta antes: se já estiver paga com saldo zerado, nada é enviado e
o título local passa a pago (sem atribuir a quitação ao ORBITA); se aparecer
paga sem saldo zerado, nada é enviado nem marcado ("conta inconsistente"); se
não estiver em aberto ou não tiver categoria, nada é enviado. Uma quitação sem resposta conclusiva vira
"quitação não confirmada" e só a conferência resolve — clicar de novo não envia
outra.

## O que não fazer

- Não lançar de novo a mesma despesa: enquanto a operação estiver pendente, o
  mesmo conteúdo é recusado pelo servidor.
- Não quitar pelo próprio Bling uma baixa pendente sem antes conferir se ela já
  aconteceu.

## Limites conhecidos (bloqueio residual de FIN-01)

- **Ausência não é provável.** O contrato oficial do Bling não filtra nem lista
  por `numeroDocumento` (`openapi-Dw6cY8yQ.json`), e o invariante do ticket é
  "busca vazia não prova ausência". Por isso não existe "declarar que a conta
  não existe e lançar de novo": uma operação sem conta encontrada fica em
  revisão manual indefinidamente, bloqueando só lançamentos idênticos. Se o
  operador lançar a despesa por fora, deve registrar isso no próprio Bling;
  encerrar a pendência exige decisão de produto fora do PRE-002.
- Baixas enviadas antes desta versão não têm a referência `ORBQ-` no histórico;
  se ficaram sem desfecho, só a revisão manual as resolve.
- O reparo do título só usa a conta confirmada e ainda compatível com a
  intenção (mesmo id, valor, vencimento, emissão e fornecedor). Se a conta foi
  editada no Bling depois, o reparo fica pendente com "dados diferentes" e
  exige correção administrativa.
- Um título vinculado não pode ser apagado (o banco recusa): o vínculo nunca
  fica órfão. Corrigir um vínculo inconsistente é ação administrativa fora da
  tela.

## Rollback

Pausar a conferência (não clicar / remover a rota), manter o operador em
revisão manual. Recibos, tentativas e baixas são append-only e a migration 74 é
forward-only: nunca apagar recibos nem repetir POST desconhecido como
recuperação.
