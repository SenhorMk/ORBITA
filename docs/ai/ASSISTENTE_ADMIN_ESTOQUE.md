# Assistente administrativo: consulta de estoque para a banca

Em **Estoque e Produtos → Assistente de estoque**, pergunte pelo saldo de um
produto ativo usando o nome ou o SKU. `POST /api/assistente/estoque`
resolve o ator e a organização ativa pela sessão e aplica
`organization:access`, a capacidade de leitura também usada no painel.
O Groq, pelo SDK e middleware existentes, retorna só ação e referência.
O servidor exige que a referência esteja na pergunta, lê o catálogo por
organização e calcula o saldo disponível pelo físico menos o reservado.
A UI mostra o resultado do banco, inclusive quando falta saldo verificável.
O log registra desfecho, sem pergunta, produto, saldo ou dados do usuário.

Prévia local ou ambiente autorizado: disponibilize `GROQ_API_KEY` somente
no servidor. Sem a chave, o painel informa indisponibilidade. Pergunte por
um SKU de demonstração conhecido. Se o nome for ambíguo, use o SKU.

## Reuso do ERP

| Referência | Contrato existente | Uso futuro |
| --- | --- | --- |
| #114 | APIs `/api/produtos/update`, `/api/produtos/arquivar`, comandos de catálogo e auditoria comercial | Propostas de edição seguem o mesmo serviço e revalidam capacidade |
| #115 | `/api/clientes/update`, `/api/pedidos/manual` e `registrar_venda_manual_com_posse` | Proposta de pedido vinculada a cliente e itens da organização |
| #116 | Revogação de DML direto em seis tabelas comerciais | Nenhuma ferramenta de escrita no navegador ou SQL gerado pelo modelo |
| #155 | `/api/pedidos/status`, estorno e alinhamento de saldo Bling | Uma devolução exige contrato próprio. Estorno de cancelamento não equivale a uma devolução |
| MSG-011 | `/api/sac/pedidos/retrato` e `retratoDoPedido` | Reaproveitar leitura escopada e minimização. Autorização de cliente e de comerciante têm entradas distintas |
| #163 | `docs/ai/ASSISTENTE_ORBITA.md`, contexto B | Ferramentas de comerciante só na sessão do painel |

## Por que a baixa não está disponível

`database/56_baixa_estoque_com_ator.sql` contém
`baixar_estoque_organizacao`. A função diminui saldo e grava a movimentação
na mesma transação. Ela recebe o ator como argumento, não recebe uma chave
de confirmação/execução idempotente e só testa saldo físico. Usá-la
diretamente após confirmar permite dois débitos quando o primeiro commit
acontece e a resposta se perde, além de poder consumir saldo reservado.

A menor extensão segura é um comando transacional que reutilize essa RPC:
validar permissão persistida e produto de demonstração permitido, travar a
linha do produto, conferir saldo livre e registrar uma chave única de comando
e seu resultado na mesma transação da baixa. A confirmação deve ser um clique
sobre uma proposta emitida pelo servidor, vinculada à sessão, organização,
produto, quantidade e prazo. Repetir a mesma confirmação devolve o resultado
anterior. Uma troca de dados ou um comando vencido exige nova proposta.
A movimentação e a trilha registram o ator confirmado. O teste fica local
e usa produto de demonstração sem vínculo Bling, sem chamar o provedor
comercial. Os esquemas de rascunho em `contratos.ts` não são executáveis.

## Validação de navegador em laboratório

Sessão real de comerciante sintético, banco Supabase descartável e Groq real.
O produto DEMO-BANCA começou com 8 unidades físicas e 2 reservadas.
A pergunta retornou 6 disponíveis. Um pedido de baixa foi recusado e a
consulta seguinte retornou as mesmas 6 unidades. A verificação em banco
confirmou zero movimentos para o produto. O servidor registrou os desfechos
ok, escrita_indisponivel e ok, sem retornar esses dados ao modelo.
A etapa de confirmação e a auditoria de escrita dependem do comando acima.
