# Reconciliação financeira (PRE-002)

Para quem opera o Financeiro quando o Bling não confirmou uma criação de conta a
pagar ou uma quitação.

## O que aparece

Na aba Financeiro, o quadro **"Operações com resultado não confirmado pelo
Bling"** lista cada operação `em_voo` ou `indeterminada` (criação ou baixa), com
o botão **Conferir no Bling**. Não existe botão de lançar de novo: o efeito pode
ter acontecido.

## O que "Conferir no Bling" faz

Só lê o Bling (`GET /contas/pagar` e `GET /contas/pagar/{id}`) e grava um recibo
em `reconciliacoes_conta_pagar` com quem conferiu, quando, o método, o resultado
e a conta remota. Desfechos:

| Tela | Significado | O que fazer |
|---|---|---|
| Confirmada no Bling | prova inequívoca encontrada; a operação foi concluída e o título vinculado uma vez | nada |
| Ainda pendente | o Bling não respondeu por completo (timeout, 429, 5xx, listagem incompleta) | conferir de novo em instantes |
| Revisão manual necessária | não há prova automática (busca vazia, vários candidatos, dados divergentes, conta aberta) | conferir no próprio Bling antes de qualquer ação |

"Busca vazia" não significa que a conta não existe. Lançamentos feitos antes da
migration 74 não têm referência no Bling e sempre caem em revisão manual.

## O que não fazer

- Não lançar de novo a mesma despesa: enquanto a operação estiver pendente, o
  mesmo conteúdo é recusado pelo servidor.
- Não quitar de novo pelo Bling uma baixa pendente sem antes conferir se ela já
  aconteceu.

## Limites conhecidos

Ainda não há um fluxo para o operador declarar o desfecho de uma revisão manual
(escolher a conta certa ou registrar que ela não existe). Até lá, a operação
continua pendente e bloqueando apenas lançamentos idênticos.
