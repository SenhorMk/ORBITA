# Inventário da escrita direta — catálogo, clientes, pedidos e estoque (PRE-006A)

Escopo: `produtos`, `categorias`, `movimentacao_estoque`, `clientes`,
`pedidos` e `itens_pedido`. Base: `main` em `091fd01` + PRE-006A.
Atualizado pelo PRE-006B (base `6cb9d09`) para catálogo e estoque — ver
a seção [PRE-006B](#pre-006b--catálogo-e-estoque-por-comando-autorizado) —
e pelo PRE-006C (base `22ad2b5`) para clientes e pedidos — ver a seção
[PRE-006C](#pre-006c--clientes-e-pedidos-por-comando-autorizado). O
PRE-006D (base `9e4e3ca`, migration 81) revogou o DML do navegador — ver a
seção [PRE-006D](#pre-006d--dml-direto-revogado).

Fontes, todas executadas:
- código em `src/` (varredura de `.from(...)`/`.rpc(...)`, rotas e repositórios);
- catálogo de um laboratório descartável com a cadeia canônica;
- leitura somente leitura do projeto de desenvolvimento `etqjqeqqbjrzyyxodntv`: grants, policy de estoque e publicação Realtime iguais ao laboratório.

As regras deste inventário viram teste em dois lugares:
- `src/lib/escritaDiretaComercial.test.ts`: o que o navegador faz;
- `supabase/tests/final/escrita_direta_comercial.test.sql`: o que o banco concede.

## 1. Navegador (chave anônima + sessão do usuário)

O navegador **não grava** em nenhuma das seis tabelas e não chama RPC do banco.

| Caller | Tabela | Operação | Autorização | Boundary |
|---|---|---|---|---|
| `src/app/page.tsx` (itens do pedido selecionado) | `itens_pedido` (+ `produtos` embutido) | SELECT | RLS por membership | leitura direta |
| `src/components/ManualOrderModal.tsx` (opções do formulário) | `clientes`, `produtos` | SELECT | RLS por membership | leitura direta; o servidor relê tudo no envio |
| `src/components/produtos/ImagemDoProduto.tsx` | Storage `produto-imagens` | upload | URL assinada emitida por `POST /api/produtos/imagem/upload` (`organization:manage`) | boundary existente |

Todas as mutações saem por `fetchWithAuth` para as rotas da seção 2.

**Realtime:** nenhuma das seis tabelas está na publicação `supabase_realtime`, nem no laboratório nem no projeto de desenvolvimento. O único canal do navegador, `espelhoDaMensageria.ts`, é da mensageria e está fora do escopo.

## 2. Servidor (service role, escopo verificado)

| Rota / caller | Tabelas escritas | Sessão + organização | Capacidade | Zod | Auditoria |
|---|---|---|---|---|---|
| `POST /api/produtos/update` | `produtos` | contexto verificado | `organization:manage` | sim | **`catalog.product_*` (PRE-006B)** |
| `POST /api/produtos/arquivar` | `produtos` (RPC `arquivar_produto`) | `autorizarCorrecaoOperacional` | `organization:manage` | sim | eventos `produtos.arquivamento.*` |
| `POST /api/produtos/imagem/{upload,confirmar,remover,sincronizar}` | `produtos` | `autorizarCorrecaoOperacional` | `organization:manage` | sim | `auditarCorrecao` |
| `POST /api/categorias/sync` | `categorias` | escopo verificado | `organization:manage` | sim | **`catalog.categories_*` (PRE-006B)** |
| `POST /api/clientes/update` | `clientes` | contexto verificado | `organization:manage` | sim | **`customer.contact_*` (PRE-006C)** |
| `POST /api/clientes/delete` | `clientes` | `autorizarCorrecaoOperacional` | `organization:manage` | sim | `auditarCorrecao` |
| `POST /api/pedidos/manual` (+ `/reconciliar`) | `pedidos`, `itens_pedido`, `clientes.bling_id`, `produtos`/`movimentacao_estoque` (RPCs da venda manual) | escopo verificado | **criar: membership** (corrigido no PRE-006C: a tabela dizia `organization:manage`); `/reconciliar` muta só com `organization:manage` | sim | ledger de tentativas/intervenções + **`order.manual_sale_*` (PRE-006C)** |
| `PUT`/`DELETE /api/bling/pedidos/[id]` | `pedidos`, `itens_pedido` | escopo verificado | `organization:manage` | sim | **`order.updated`/`order.deleted`/`order.reconcile_required` (PRE-006C)** |
| `POST /api/pedidos/status` | `pedidos`, `produtos.estoque` + `movimentacao_estoque` (RPC `alinhar_estoque_ao_saldo_do_bling`, PRE-006C) | escopo verificado | **`organization:manage` (PRE-006A)** | sim | **`order.status_*` (PRE-006C)** |
| `POST /api/sync` (job) | `produtos`, `clientes`, `pedidos`, `itens_pedido` | escopo verificado | `organization:manage` | — | job durável |
| `POST /api/bling/webhook` | `produtos`, `clientes`, `pedidos`, `itens_pedido` | HMAC + conexão autenticada | n/a (integração) | sim | inbox idempotente |
| `POST /api/chatwoot/sync` → `vincularSacAoErp` (RPC `registrar_cliente_do_sac`, PRE-006C) | `clientes` (INSERT de auto-registro, nunca UPDATE) | contexto verificado | membership (`organization:access`) — decisão no PRE-006C | — | **`customer.sac_contacts_registered` (PRE-006C)** |
| `DbAdapter` (privacidade) | `clientes` | — | — | — | sem caller em produção (só testes) |

Funções do banco que escrevem nas seis tabelas: todas executáveis **só** por
`service_role` ou rodam como gatilho:
- `arquivar_produto`, `registrar_exclusao_de_produto_no_bling`;
- `baixar_estoque_organizacao`, `registrar_venda_manual`;
- leases e divergência da foto;
- retenção e encerramento;
- backfills de tenancy;
- gatilhos de reserva.

`rpc_criar_pedido_manual` não tem grant para ninguém: é legado e não é chamável.

## 3. Banco (o que `authenticated` pode fazer direto pelo PostgREST)

| Tabela | Grant DML de `authenticated` | RLS | Policies |
|---|---|---|---|
| `produtos`, `categorias`, `clientes`, `pedidos`, `itens_pedido` | INSERT, UPDATE, DELETE | ligada | `*_org_{select,insert,update,delete}`, só membership |
| `movimentacao_estoque` | INSERT, UPDATE, DELETE | ligada | antes: legada `organização OR user_id = auth.uid()`; **agora** `movimentacao_estoque_org_*`, só membership (migration 78) |

Nenhuma RPC executável por `anon`/`authenticated` escreve nas seis tabelas.
Os grants ficam intactos nesta fatia; a revogação é do PRE-006D.

> **PRE-006D (migration 81):** a coluna "Grant DML de `authenticated`" acima é
> o estado anterior. Depois da 81, `authenticated` só tem SELECT nas seis
> tabelas — ver a matriz na seção PRE-006D.

## Achados

1. **Corrigido — estoque cross-tenant** (migration 78). A policy legada aceitava `user_id = auth.uid()` em USING e WITH CHECK. Provado em laboratório:
   - quem não é membro de A (um ex-membro) lia, alterava e apagava as movimentações que gravou no livro de A;
   - forjava movimentação nova em A;
   - um membro de A gravava em B pelo mesmo ramo.

   Agora vale só membership, como nas outras cinco tabelas. Contraprova: recriar a policy legada derruba os casos 1-4, 7 e 8 do teste final.
2. **Corrigido — `POST /api/pedidos/status` sem capacidade.** Um `member` mudava a situação do pedido e o estoque, aqui e no Bling. A rota não tem tela que a chame; agora exige `organization:manage`, como as demais mutações comerciais.
   - **Correção do PRE-006C:** a rota **tem** tela. É o cancelamento de pedido (`src/components/vendas/CancelamentoDePedido.tsx`).
3. **Para decisão (PRE-006C / mensageria) — auto-registro de cliente pelo SAC.** `POST /api/chatwoot/sync`, chamado pela tela de mensageria, cria cliente (nome `Cliente Chatwoot` quando o contato não tem nome, `bling_id` temporário) para qualquer membro.
   - Sem vazamento entre organizações.
   - Mas é escrita em `clientes` sem `organization:manage` e sem auditoria.
   - Exigir a capacidade aqui pararia a sincronização do SAC para membros, por isso não foi alterado.
4. **Fora do escopo:** policies com `auth.uid()` em `financeiro` e `integracoes_bling` (PRE-007A / PRE-008). As demais são checagens de admin.
5. **Auditoria das rotas existentes:** produtos/update, categorias/sync e bling/pedidos não registram evento de auditoria. clientes/update e pedidos/status registram só a falha. Fica para PRE-006B/C, que tocam esses fluxos; este PR não cria boundary novo que precise auditar.
   - **PRE-006B fechou produtos/update e categorias/sync** (seção abaixo).
   - **Continua para PRE-006C:** bling/pedidos, clientes/update e pedidos/status.

## Comandos ausentes

Nenhum fluxo do navegador grava direto, então **não há comando novo a criar**:
toda mutação legítima do produto já tem rota com escopo verificado,
`organization:manage` e Zod. Consequência para os próximos tickets:
- **PRE-006B/C:** não há caller de DML no navegador a migrar. O que resta é o grant de DML de `authenticated`, que o PRE-006D revoga, e as leituras diretas da seção 1.
- **PRE-006D:** pode revogar INSERT/UPDATE/DELETE das seis tabelas para `authenticated` sem quebrar fluxo. Os testes deste PR mostram que nenhuma mutação do produto depende desse grant.

## Matriz de efeitos externos (17 casos)

Inaplicável: esta fatia não cria efeito externo novo. A rota de situação
apenas ganhou uma recusa **antes** de qualquer chamada ao Bling.

## PRE-006B — catálogo e estoque por comando autorizado

Base: `main` em `6cb9d09`. Os callers foram revalidados no código atual, não
copiados da seção 1. A revalidação incluiu:
- import relativo do cliente do navegador;
- `.from(<variável>)`;
- o cliente Supabase com a sessão do usuário no servidor (`createActorScopedSupabaseClient`);
- Storage;
- leituras do modal de venda.

### O que já estava correto e foi preservado

| Fronteira | Evidência |
|---|---|
| Navegador sem DML em `produtos`, `categorias` e `movimentacao_estoque` | `src/lib/escritaDiretaComercial.test.ts`; o navegador só usa `auth.getSession`, Storage com URL assinada e as leituras inventariadas |
| `produtos/update`, `categorias/sync`, `produtos/arquivar` e `produtos/imagem/*`: organização da sessão verificada e `organization:manage` | `produto-update.test.ts` ("autorização"), `handlers.test.ts`, `ticket-22-fronteira-das-rotas-migradas.test.ts` |
| Service role filtra `organizacao_id` em toda leitura e escrita de catálogo | `produtoRepository.ts`, `route.ts` de categorias e produtos; categoria de outra organização é recusada antes do Bling (`produto-update.test.ts`) |
| Movimentação de estoque só pela venda manual: `registrar_venda_manual_com_posse` → `baixar_estoque_organizacao`, com o ator verificado, `service_role` apenas | pgTAP `baixa_estoque_com_ator` (7), `venda_manual_transacional` (11) |
| Retry da venda não duplica a baixa | pgTAP `tentativas_venda_manual_idempotentes` (111) e `replay_de_item_nao_consome_estoque` (12); concorrência do `test:db` (mesma tentativa reivindicada uma vez; mesmo item aplicado uma vez; posse cercada recusada com `55P03` sem efeito residual) |
| Auditoria de arquivamento e de foto | eventos `produtos.arquivamento.*` e `catalog.product_image_*` já existentes |

Não há caller de DML do navegador a migrar.

### Defeitos comprovados e corrigidos

1. **A edição do produto reaplicava um saldo velho.** O modal enviava `estoque` em toda gravação, até quando só o nome mudava. A rota lançava esse valor como balanço absoluto no Bling (`POST /estoques`, operação `B`) e no espelho local.
   - Efeito: uma venda feita com a tela aberta era desfeita, e as unidades vendidas voltavam ao estoque nos dois lados. Um retry da edição repetia o mesmo efeito.
   - Agora o formulário só manda o saldo no cadastro ou quando a pessoa o altera (`saldoParaEnvio`, `produtoContract.ts`).
2. **O espelho local recebia saldo não confirmado.** O espelho gravava `estoque: body.estoque ?? 0`:
   - uma edição sem saldo zerava o estoque local;
   - um saldo recusado pelo Bling entrava no ORBITA mesmo assim.

   O estoque local é o que `baixar_estoque_organizacao` confere na venda manual. Agora o espelho só recebe saldo que o Bling confirmou; caso contrário, a coluna fica como estava (`ProdutoStorePort.estoque` opcional, `ProdutoRepository.upsert`).
3. **Timeout ou `5xx` virava "O Bling recusou".** A rota devolvia 400 e tratava a falha como recusa. Num cadastro sem SKU, repetir criava um segundo produto no ERP. Pior, timeout e conexão perdida chegam do adapter como **exceção**, e esta escapava do handler como `500` genérico, sem desfecho nem auditoria.
   - Agora a exceção é convertida em falha sem resposta (`status` `0`, `semExcecao`).
   - Agora a rota usa `classificarFalhaDeCriacaoNoBling`, o mesmo classificador da venda manual e da conta a pagar:
     - recusa comprovada → `400`;
     - qualquer outra falha → `502` e estado desconhecido. No cadastro, a mensagem manda não cadastrar de novo e sincronizar antes; na atualização, um `PATCH` idempotente, diz que repetir é seguro.
4. **Faltava auditoria de negócio** em `produtos/update` e `categorias/sync`. Os eventos novos estão na migration 79 e em `auditEventCatalog.ts`. Eles passam por `recordAuditEvent` → `registrar_evento_auditoria`, que só `service_role` executa e que reconfere a membership do ator. Cada evento leva ator e organização do escopo verificado, recurso, `correlation_id` e o desfecho:

   | Evento | Quando |
   |---|---|
   | `catalog.product_saved` | Bling confirmou e o ORBITA espelhou; `saldo` = `nao_solicitado`/`aplicado`/`nao_confirmado` (falha parcial do saldo) |
   | `catalog.product_save_rejected` | recusa comprovada do Bling; nada gravado |
   | `catalog.product_reconcile_required` | `bling_sem_confirmacao` (indeterminado) ou `espelho_local_falhou` (Bling confirmou, ORBITA não) |
   | `catalog.categories_synced` | sincronização concluída, com a contagem |
   | `catalog.categories_sync_failed` | interrompida; `categorias_gravadas` diz quantas páginas anteriores ficaram (falha parcial, não "nada mudou") |

   - A metadata não leva nome, SKU, preço, descrição nem corpo do Bling.
   - Recusas antes de qualquer efeito (sessão, capacidade, corpo inválido, categoria alheia) não geram evento. Isso segue a convenção das demais rotas comerciais.
   - Falha ao gravar a auditoria vai para o log técnico redigido (`registrarFalhaInterna`) e não altera a resposta de uma operação já decidida no Bling.
5. **O detector do PRE-006A tinha pontos cegos.** Ele não reconhecia como navegador quem importa `./supabaseClient` por caminho relativo. Também não olhava `.from(<variável>)` nem o cliente com a sessão do usuário no servidor, que depende dos mesmos grants que o PRE-006D revoga. Os três agora são regras, com contraprova permanente nos próprios detectores.

### Revisão do PR #114: a tela respeita o desfecho

A revisão independente achou dois furos na tela; os dois foram corrigidos.

1. **O modal oferecia retentativa num resultado indeterminado.** O `ErrorLogModal` mostrava "Tentar Novamente" e o botão principal continuava ativo depois de um `502` sem confirmação ou de um `500` com o Bling já confirmado. Repetir o cadastro podia duplicar o produto no ERP.
   - A rota agora devolve `reconciliacao: { motivo, blingId }` no contrato compartilhado (`produtoUpdateResponseSchema`).
   - O cliente classifica a resposta por esse estado, e não pelo texto (`src/components/produtos/gravacaoDoProduto.ts`). Também conta como indeterminado: rejeição de `fetch`, resposta que não é o JSON do contrato (como um `504` do gateway) e `5xx` sem estado.
   - No indeterminado, o modal tira o "Tentar Novamente", desabilita o salvar ("Aguardando reconciliação") e mostra um alerta persistente.
   - O bloqueio vale para aquele produto (ou para o cadastro novo) enquanto a página estiver aberta. Fechar e reabrir o modal não o libera; outro produto segue editável.
2. **O sucesso parcial sumia.** Os `avisos` da rota não chegavam à tela, e o modal fechava em 1,5 s. Agora a rota informa `saldo`, e o modal mostra "Produto salvo, com pendência" com o aviso. O modal relê o catálogo e não fecha sozinho; quem fecha é a pessoa.

3. **Cadastro confirmado ainda podia ser reenviado.** Com o sucesso parcial, o botão principal seguia ativo; com o sucesso completo, havia 1,5 s antes do fechamento. Um novo clique era outra intenção de cadastro: sem SKU, um segundo produto no Bling.
   - Agora, depois do primeiro cadastro confirmado (completo ou parcial), o formulário bloqueia novos envios naquela abertura ("Produto cadastrado").
   - O aviso continua visível e o catálogo continua sendo relido.
   - Uma nova abertura do formulário libera outro cadastro. A edição de produto existente não é afetada.
   - Contraprovas: remover a marcação, só o guard, ou a liberação na nova abertura derruba os testes `mesma abertura`.

**Contraprovas:** foram 9 sabotagens, e cada uma derrubou o teste correspondente:
- "Tentar Novamente" de volta;
- indeterminado sem bloqueio;
- reabrir liberando o salvar;
- reconciliação lida como recusa;
- rede perdida lida como recusa;
- `502` sem estado;
- parcial fechando sozinho;
- avisos não propagados;
- rota sem `saldo`.

### Matriz de efeitos externos (17 casos)

Efeitos tocados nesta fatia:
- `POST /produtos` e `PATCH /produtos/{id}`;
- `POST /estoques` (balanço).

A sincronização de categorias só lê o Bling.

| Caso | Tratamento |
|---|---|
| 1 Antes do envio | consulta por SKU falhou → nada escrito; `400`, sem evento. Credencial ausente no cadastro não se distingue de timeout pelo adapter atual → tratada como desconhecida (conservador) |
| 2 Recusa definitiva | `400`, `catalog.product_save_rejected` |
| 3 Timeout · 4 ACK perdido · 5 2xx inválido · 7 5xx | `502`, estado desconhecido, `catalog.product_reconcile_required`; nada local gravado |
| 6 429 | conservador: tratado como desconhecido, como na venda manual |
| 8 Retry automático | nenhum: a rota não repete chamada ao Bling |
| 9 Retry humano | cadastro desconhecido: a mensagem manda sincronizar, não recadastrar. Atualização e saldo são idempotentes (`PATCH`, balanço absoluto) |
| 10 Crash depois do efeito · 11 crash antes do commit | Bling confirmou e o espelho falhou → `500` com o id do Bling e evento `espelho_local_falhou`; a sincronização do catálogo reconcilia |
| 12 Duplicata | SKU exato evita a segunda criação; sem SKU, o risco residual está abaixo |
| 13 Fora de ordem · 14 atrasado · 15 webhook repetido | inaplicáveis à rota; o webhook de produto tem inbox idempotente e tombstone (PRE-004) |
| 16 Compensação | nenhuma automática: não se apaga produto no Bling por falha local |
| 17 Reconciliação | sincronização do catálogo (`POST /api/sync`), por `bling_id` |

### Testes que provam

- **Sem DML direto:**
  - `src/lib/escritaDiretaComercial.test.ts` (navegador, sessão do usuário no servidor, `.from` não literal, contraprovas dos detectores);
  - pgTAP final `escrita_direta_comercial` (grants e policies; nenhuma RPC do navegador escreve).
- **Jornada:** a jornada UI → API → banco está coberta em camadas:
  - `ProductDetailModal.test.tsx`: o corpo enviado;
  - `produto-update.test.ts`: rota, Bling, espelho e auditoria;
  - `produto-exclusao-e-deduplicacao.test.ts`: rota sobre o repositório real;
  - `handlers.test.ts` de categorias.
- **Isolamento e permissão:** organização A/B, membro sem capacidade e payload inválido sem efeito estão nos mesmos arquivos.
- **Retry:** `produto-update.test.ts` (balanço repetido não acumula) e os pgTAP de idempotência da venda manual.
- **Auditoria:**
  - pgTAP `eventos_de_auditoria_do_catalogo`: eventos no catálogo SQL; membro grava; dono de B não grava em A; `authenticated` não grava;
  - `auditEventCatalog.test.ts`: TypeScript × SQL.
- **Contraprovas executadas:** reintroduzir cada defeito derruba o teste correspondente. Os dez casos:
  - saldo no espelho;
  - timeout como recusa;
  - produto sem auditoria;
  - auditoria derrubando a resposta;
  - modal reenviando saldo;
  - categorias sem auditoria;
  - parcial como zero;
  - detector cego para import relativo;
  - evento sem projeção SQL;
  - exceção de rede escapando como `500`.

### Riscos que permanecem para o PRE-006D e depois

- **DML direto ainda concedido.** `authenticated` mantém INSERT/UPDATE/DELETE em `produtos`, `categorias` e `movimentacao_estoque`.
  - Um `member` (sem `organization:manage`) ainda pode, pelo PostgREST com o próprio token, alterar `produtos.estoque` ou inserir movimentação na própria organização.
  - A RLS impede outra organização; só a revogação fecha isso.
  - Nenhum fluxo do produto depende desse grant: os testes acima o provam.
- **Cadastro sem SKU em estado desconhecido.** Não há chave de idempotência aceita pelo Bling em `POST /produtos`, nem ledger de tentativa de cadastro.
  - O estado fica visível (`502` + evento crítico), mas evitar o recadastro depende de a pessoa seguir a mensagem.
  - Um ledger durável, como o da venda manual, seria um ticket próprio.
- **Saldo editado em concorrência com uma venda.** Alterar o saldo é um balanço absoluto. Se a pessoa muda o saldo enquanto uma venda acontece, o valor digitado vence: é a semântica de inventário. O que este ticket elimina é o reenvio silencioso do saldo sem alteração.
- **`pedidos/status` grava `produtos.estoque`** com o saldo lido do Bling, sem movimento no livro. É do PRE-006C, que trata pedidos.
- **Fora de escopo:**
  - as rotas de pedidos e clientes (PRE-006C);
  - o auto-registro de cliente pelo SAC (achado 3).

## PRE-006C — clientes e pedidos por comando autorizado

Base: `main` em `22ad2b5`. Ambiente de verificação: Windows local; laboratório Supabase descartável em Docker (`npm run test:db`). Nenhum banco remoto, Bling ou Chatwoot reais.

### Revalidação

**Navegador:**
- Não grava em `clientes`, `pedidos` nem `itens_pedido`: o detector estendido no PRE-006B continua verde.
- Só lê `itens_pedido` (`page.tsx`) e `clientes` (`ManualOrderModal`).

**Dois erros do inventário PRE-006A:**
- `POST /api/pedidos/manual` não exige `organization:manage`. A tabela da seção 2 dizia que sim.
- `POST /api/pedidos/status` é chamado pela tela de cancelamento.

### Classificação das operações

| Operação | Antes | Classificação | Depois |
|---|---|---|---|
| `POST /api/clientes/update` | Org verificada, `organization:manage`, Zod; desfecho já distinguia recusa, ambíguo e parcial | CORRETA na fronteira; faltava auditoria | Auditoria `customer.contact_saved` / `_save_rejected` / `_save_reconcile_required` |
| `POST /api/clientes/delete`, `/reativar` | `autorizarCorrecaoOperacional`, `auditarCorrecao`, tombstone com trava (PRE-005) | CORRETA | Preservada |
| `POST /api/chatwoot/sync` (auto-registro) | Qualquer membro; lia os telefones e depois inseria; sem auditoria | VULNERÁVEL (duplicação concorrente) + DEPENDENTE DE DECISÃO (capacidade) | RPC `registrar_cliente_do_sac` com trava consultiva; só insere; auditoria agregada |
| `POST /api/pedidos/manual` | Membership; ledger de tentativas idempotente; baixa atômica com ator | CORRETA quanto a efeito e idempotência; DEPENDENTE DE DECISÃO quanto à capacidade | Auditoria `order.manual_sale_recorded` / `_unresolved` |
| `POST /api/pedidos/manual/reconciliar` | Mutação só com `organization:manage` | CORRETA | Preservada |
| `POST /api/pedidos/status` | `organization:manage`; falha do Bling virava "Erro interno"; estoque lido e sobrescrito sem condição nem livro | VULNERÁVEL | Desfecho tipado; alinhamento condicional com lançamento; auditoria; tela mostra a pendência |
| `PUT`/`DELETE /api/bling/pedidos/[id]` | `organization:manage`; posse local provada antes do Bling; sem auditoria; exclusão parcial respondia "indisponível" | CORRETA na fronteira; faltavam auditoria e o parcial nomeado | Auditoria; `OrderRemovedRemotelyOnly` com orientação de repetir (convergente) |
| `POST /api/bling/webhook` | HMAC + inbox idempotente | CORRETA | Preservada |
| `POST /api/sync` (job) | Job durável, `organization:manage` | CORRETA | Preservada |
| `DbAdapter` (privacidade) | Sem caller em produção | CORRETA (inalcançável) | Preservada |

### Defeitos comprovados e corrigidos

1. **Auto-registro do SAC duplicava cliente.** `linkSacToErp` lia os telefones e depois inseria. Duas sincronizações simultâneas (dois atendentes) criavam o mesmo cliente duas vezes, porque não há restrição única por telefone (um telefone pode ser legitimamente compartilhado).
   - Agora a decisão é da função `registrar_cliente_do_sac` (migration 80). Ela usa uma trava consultiva por (organização, telefone), confere a membership do ator, só insere e nunca sobrescreve.
   - A rota informa `clientes: { criados, falhas }` e audita contagens, sem telefone nem nome.
2. **`pedidos/status` desfazia a baixa da venda manual.** O alinhamento lia o estoque e depois gravava o saldo do Bling, sem condição e sem lançamento.
   - Uma baixa entre a leitura e a escrita era desfeita, e o livro deixava de explicar o saldo.
   - Agora `alinhar_estoque_ao_saldo_do_bling` faz compare-and-set sob a trava da linha. Ela devolve um destes desfechos:
     - `alinhado`;
     - `ja_alinhado` (retry);
     - `divergiu` (mudou depois da leitura; nada escrito);
     - `saldo_invalido`.
   - O delta aplicado é lançado no livro na mesma transação (`origem = 'ALINHAMENTO_SITUACAO_BLING'`).
3. **`pedidos/status` inventava desfecho.**
   - Recusa e timeout do Bling viravam o mesmo "Erro interno" 500.
   - O Bling confirmado com falha local também.
   - Falha ao ler o saldo depois da mudança derrubava a requisição, como se nada tivesse mudado.

   Agora:
   - `updateSituacaoPedido` devolve falha tipada;
   - recusa comprovada → `400`;
   - timeout, 429, 5xx ou exceção → `502` com `reconciliacao: bling_sem_confirmacao`;
   - Bling confirmado e espelho falho → `500` com `reconciliacao: espelho_local_falhou`;
   - estoque não conferido ou com pendência → `200` com `estoque: 'requer_reconciliacao'` e o aviso. A tela de cancelamento mostra "cancelado, com pendência" em vez de "estoque alinhado com sucesso".
4. **Exclusão parcial de pedido sem nome.** O Bling apagava e o ORBITA não, e a resposta era "Operação indisponível". Agora o desfecho é `OrderRemovedRemotelyOnly`, com a orientação de repetir: o Bling responde 404 e a exclusão local é refeita.
5. **Auditoria comercial ausente.** Agora há eventos em `clientes/update`, no SAC, em `pedidos/status`, em `bling/pedidos` e na venda manual (onze eventos novos, migration 80).
   - O ator e a organização vêm do escopo verificado. A metadata só tem ids técnicos, operação, desfecho e contagens.
   - O módulo comum `criarAuditoriaComercial` nunca lança. A falha da trilha vai para o log técnico redigido, sem transformar um efeito confirmado em falha reexecutável.
   - Na venda manual, a auditoria decora as duas portas do ledger (`comAuditoriaDaVenda`) e registra só o desfecho que o banco gravou.

### Revisão do PR #115: saldo comprovado e situação confirmada

1. **Saldo ausente virava zero.** O adapter fazia `Number(saldoFisicoTotal ?? saldoFisico ?? 0)`, e um produto sem saldo informado gerava uma saída de estoque.
   - Agora `saldosComprovados` (`pedidos/status/saldosDoBling.ts`) só aceita saldo explícito e inteiro finito. O zero informado continua valendo.
   - Fica fora do mapa e pendente de reconciliação: produto sem campo, `null`, texto, fração, formato desconhecido ou repetido com valores diferentes. Nenhuma RPC de alinhamento recebe saldo não comprovado.
2. **O nome do navegador decidia o status local.** O id ia ao Bling e o `novaSituacaoNome` do navegador virava o status no ORBITA, então os dois podiam divergir.
   - Agora a situação é confirmada pela conta antes de qualquer efeito, com `obterSituacoesDePedidoDeVenda`.
   - Id fora da conta ou nome divergente → `400`. Falha na leitura → `502` "nada foi alterado". Nos três casos não há mudança no Bling nem evento.
   - O status local vem do nome confirmado. Ids de situação são por conta e não se confundem com o código numérico de status.
3. **Contraprovas:** cada sabotagem derrubou o teste correspondente.
   - K1: reintroduzir `?? 0`.
   - K2: voltar a confiar em `novaSituacaoNome`.
   - K3: aceitar id fora da conta.
   - K4: inventar situação quando a leitura falha.

### Decisões pendentes (não implementadas)

1. **Capacidade do SAC.** O modelo tem só `organization:access` e `organization:manage`.
   - Exigir `manage` no auto-registro pararia a mensageria dos atendentes.
   - Mantido em `access`, com o efeito estreitado: só INSERT de cliente novo com `bling_id` temporário, sem tocar em cliente existente e sem ir ao Bling.
   - Alternativas para a proprietária:
     - (a) manter assim;
     - (b) criar uma capacidade `sac:operate`;
     - (c) tirar o auto-registro da sincronização e torná-lo ação explícita de quem administra.
2. **Venda manual por `member`.** O ticket 22 decidiu e testou que "um `member` vende" (`ticket-22-fronteira-comercial.test.ts`). Isso diverge de `organizationCapabilitiesForRole` ("member só acessa os dados").
   - Não foi alterado.
   - A auditoria agora registra o ator de cada venda.
   - Alternativas:
     - (a) manter;
     - (b) exigir `organization:manage`, que é uma linha na rota e uma mudança no teste do ticket 22.
3. **Contato excluído e recriado pelo SAC.** `clientes/delete` remove fisicamente o contato sem histórico. Se o telefone ainda conversa no Chatwoot, a próxima sincronização o recria como cliente novo.
   - Pode ser o comportamento desejado (lead que voltou) ou não.
   - Exige decisão e, se for o caso, um registro de "não recriar".
4. **`PUT` em pedido `#MANUAL-` legado.** `OrderAccess.update` devolve sucesso sem efeito nenhum. Foi preservado (edição de pedido manual antigo) e não é auditado como edição real.

### Matriz de efeitos externos (17 casos)

| Caso | `pedidos/status` (PATCH situação) | `bling/pedidos` (PUT/DELETE) | `clientes/update` |
|---|---|---|---|
| 1 Antes do envio | Corpo inválido ou pedido de outra org → 400/404, sem chamada | Idem (posse local antes do Bling) | Já tratado (`retrySafe`) |
| 2 Recusa definitiva | 400 + `order.status_change_rejected` | 502 genérico (sem distinção; residual) | 400 + `customer.contact_save_rejected` |
| 3 Timeout · 4 ACK perdido · 5 2xx inválido · 7 5xx | 502 + `reconciliacao` + `order.reconcile_required`; nada local | 502 + `order.reconcile_required` | 502 ambíguo + `customer.contact_save_reconcile_required` |
| 6 429 | Desconhecido (conservador) | Desconhecido | Limite comprovado → `retrySafe` (inalterado) |
| 8 Retry automático | Nenhum | Nenhum | Nenhum |
| 9 Retry humano | A tela não repete; a mudança de situação é idempotente; o alinhamento repetido é `ja_alinhado` | A exclusão repetida converge (404 → local) | A tela já não oferece repetir no ambíguo |
| 10 Crash depois do efeito · 11 crash antes do commit | Espelho falho → 500 parcial; alinhamento é uma transação | Exclusão local falha → `OrderRemovedRemotelyOnly` | Já tratado (`reconcileRequired`) |
| 12 Duplicata | Compare-and-set + `ja_alinhado` | Exclusão idempotente | Inalterado |
| 13 Fora de ordem · 14 atrasado | O alinhamento com leitura velha → `divergiu` | n/a | n/a |
| 15 Webhook repetido | Inbox idempotente (inalterado) | idem | idem |
| 16 Compensação | Nenhuma automática | Nenhuma | Nenhuma |
| 17 Reconciliação | Sincronização de pedidos/catálogo | idem | Sincronização de clientes |

O auto-registro do SAC não tem efeito externo: só lê o espelho local do Chatwoot.

### Testes e contraprovas

| Prova | Onde |
|---|---|
| Org A não cria/edita/movimenta B; service role filtra o tenant | pgTAP `final/comandos_de_clientes_e_pedidos` (5, 12, 16); `bling/pedidos` 404 sem evento; `pedidos/status` 404 sem Bling |
| Membro sem capacidade não altera pedido crítico | `pedido-status.test.ts`, `handlers.test.ts` (inalterados) |
| Atendente do SAC continua operando | `integrationService.test.ts` (escopo `member`); pgTAP 1-2 |
| Entrada inválida recusada antes do efeito | `cliente-update-auditoria.test.ts`, `pedido-status.test.ts` |
| Concorrência não duplica | `scripts/database-concurrency-comandos-comerciais.mjs`: dois registros do SAC com bloqueio `advisory` → 1 cliente; baixa × alinhamento com leitura velha (`transactionid`) → `divergiu`, estoque 4; dois alinhamentos idênticos → 1 lançamento |
| Retry não repete baixa | pgTAP 10-11 (`ja_alinhado`, nenhum lançamento novo); idempotência da venda manual (inalterada) |
| Timeout/429/5xx/ACK perdido/2xx inválido sem sucesso inventado | `pedido-status.test.ts` (5 formas), `cliente-update-auditoria.test.ts` |
| Navegador sem DML nas três tabelas | `escritaDiretaComercial.test.ts`; pgTAP 6 e 14 (o navegador não executa os comandos) |
| Auditoria = resultado real | Testes de auditoria por rota; `auditoriaDaVenda.test.ts` (desfecho recusado pelo banco não é auditado) |

**Contraprovas de aplicação:** 13 sabotagens, todas detectadas.
- B1-B5 (`pedidos/status`): desconhecido como recusa; exceção como 500; parcial como "Erro interno"; pendência como sucesso; alinhamento sem o valor lido.
- A1-A2 (SAC): telefone repetido; parcial como concluído.
- C1-C6:
  - desconhecido do cliente auditado como recusa;
  - cliente salvo sem auditoria;
  - exclusão parcial genérica;
  - desfecho recusado auditado;
  - cancelamento com pendência anunciado como sucesso;
  - evento sem projeção SQL.

**Contraprovas SQL**, em laboratório descartável, com a migration restaurada e o ledger conferido no fim:
- sem o compare-and-set, o pgTAP final falha;
- sem a trava consultiva, o ensaio de concorrência falha.

### Pendências para o PRE-006D

- `authenticated` ainda tem INSERT/UPDATE/DELETE em `clientes`, `pedidos` e `itens_pedido` (e nas outras três tabelas).
  - Nenhum caller do produto depende disso: navegador sem DML, servidor só com service role e RPCs restritas a `service_role`.
  - O cliente com a sessão do usuário (`createActorScopedSupabaseClient`) não toca as seis tabelas, e o teste garante isso.
- Até a revogação, um `member` com o próprio token ainda pode, pelo PostgREST, alterar pedido ou cliente da própria organização. A RLS impede outra organização.
- Os espelhos do Bling (webhook e `/api/sync`) ainda gravam `produtos.estoque` sem lançamento no livro. É o espelho absoluto do ERP, fora das rotas de pedido deste ticket.

## PRE-006D — DML direto revogado

Base: `main` em `9e4e3ca`. Migration `database/81_revogar_dml_direto_comercial.sql`.
Runbook de implantação e recuperação: [`docs/operations/pre-006d-runbook.md`](../operations/pre-006d-runbook.md).

**Executado** no laboratório descartável (Windows, Docker, cadeia canônica com 84 migrations no ledger):
- inventário de permissões antes e depois;
- `npm run test:db`;
- as contraprovas;
- a medição de locks.

**Não executado:** nada em banco remoto. Atualização de 2026-10-17: o revisor mediu, somente leitura, o Orbita_Staging com 77 migrations registradas e 75–81 pendentes. O código publicado lá já é a `main` `fd196f0`. A implantação em dois marcos (75–80, depois 81) está no runbook.

### Matriz de privilégios efetivos (medida com `has_table_privilege`)

Legenda: S = SELECT, I = INSERT, U = UPDATE, D = DELETE, T = TRUNCATE.

| Tabela (as seis) | Papel | Antes (01–80) | Depois (01–81) |
|---|---|---|---|
| produtos, categorias, clientes, pedidos, itens_pedido, movimentacao_estoque | `authenticated` | S I U D | **S** |
| (idem) | `anon` | — | — |
| (idem) | PUBLIC (ACL) | — | — |
| (idem) | `service_role` | S I U D T | S I U D T |

**Colunas.** Antes, `authenticated` tinha INSERT/UPDATE efetivos em 89 colunas (todas, vindas do grant de tabela). Depois, nenhuma, para `authenticated` e `anon`. A 81 revoga no nível da tabela, o que também revoga os grants de coluna.

**Inalterados (medidos antes e depois):**
- **Herança de papéis:** `authenticated` e `anon` são concedidos a `authenticator` (sem herança) e a `postgres`. Nenhum dos dois herda escrita de outro papel.
- **Policies e RLS:** as 24 policies `*_org_{select,insert,update,delete}` continuam, só de `authenticated` e só por membership; RLS ligada nas seis.
  - As de escrita ficam sem grant que as alcance, mas são mantidas: se um grant voltar por engano, o isolamento por organização ainda vale.
  - Removê-las não traria proteção nova e tiraria essa segunda barreira.
- **RPCs:** nenhuma das funções que escrevem nas seis tabelas é executável por `anon`, `authenticated` ou PUBLIC.
  - Há 19 funções assim, entre elas `registrar_venda_manual`, `baixar_estoque_organizacao`, `alinhar_estoque_ao_saldo_do_bling`, `registrar_cliente_do_sac`, `arquivar_produto`, retenção, backfills e gatilhos de reserva.
  - `rpc_criar_pedido_manual` (legado) não é executável por ninguém.
  - As nove funções que `authenticated` executa (organização, convite, entitlements, encerramento — allowlist de `catalog_security`) não chamam nenhuma função que escreve nas seis tabelas e não montam SQL dinâmico. O teste 17 cobra isso.
- **Gatilhos:** os das seis tabelas rodam como quem dispara (`service_role` nos fluxos legítimos) ou como definer. Nenhum gatilho de outra tabela escreve nas seis.
- **Realtime:** nenhuma das seis tabelas é publicada.
- **Privilégios padrão:** `supabase_admin` concede ALL a `anon`/`authenticated` em tabelas novas criadas **por ele** em `public`. Tabelas das migrations (dono `postgres`) não herdam isso: medido, `anon` sem nada. É um risco para tabela nova e está registrado abaixo.

### Fluxos preservados

O servidor escreve com `service_role` (todas as rotas, jobs e webhook) e mantém SELECT, INSERT, UPDATE e DELETE nas seis tabelas (teste 13). No laboratório, sob `service_role`:
- baixa da venda manual;
- alinhamento ao saldo do Bling;
- livro de estoque com os dois movimentos;
- gravação do repositório com filtro de organização (testes 23-26).

O `test:db` completo passou com a 81: os pgTAP da venda manual, da reserva, das tentativas idempotentes, do SAC, do arquivamento, da foto e dos tombstones, e todos os ensaios de concorrência.

A leitura das telas continua (testes 19-22):
- o membro lê as seis tabelas da própria organização;
- não lê nada de B;
- quem não é membro não lê nada;
- itens do pedido com o produto embutido funcionam.

### Testes (`supabase/tests/final/escrita_direta_comercial.test.sql`, 28)

O teste do PRE-006A foi atualizado, não apagado. O antigo caso 10 ("grants intactos") virou a nova invariante, e o isolamento por membership continua (14, 19-21).

| # | Prova |
|---|---|
| 1-3 | owner, admin e member de A: INSERT, UPDATE, DELETE e TRUNCATE nas seis tabelas recusados por **privilégio** (a recusa por RLS conta como falha do teste) |
| 4-6 | member não altera `produtos.estoque`; owner não forja movimentação; admin não apaga o livro |
| 7 | anon: nenhuma escrita |
| 8 | as seis tabelas idênticas (hash) depois de todas as tentativas |
| 9-13 | matriz efetiva: `authenticated` só S; anon nada; PUBLIC sem ACL; nenhuma coluna gravável; `service_role` com DML |
| 14-15 | policies só por organização; RLS ligada |
| 16-17 | nenhuma RPC do navegador escreve, nem indiretamente nem por SQL dinâmico (funções de extensão excluídas) |
| 18 | sem Realtime |
| 19-22 | leitura das telas e isolamento |
| 23-26 | comandos do servidor operando |
| 27-28 | o navegador não forja auditoria nem baixa estoque por RPC |

### Contraprovas (laboratório, num único banco, cada sabotagem revertida e o ACL conferido igual ao original)

| Sabotagem | Detectada por |
|---|---|
| 1. `grant insert on clientes to authenticated` | 1, 2, 3, 9, 12 |
| 2. `grant update (estoque) on produtos to authenticated` | 4, 8, 12 (e 23-25 em cascata) |
| 3. `grant delete on movimentacao_estoque to authenticated` | 1, 2, 3, 6, 8, 9 |
| 4. `grant execute on baixar_estoque_organizacao to authenticated` | 16, 28 |
| 5. `grant insert (colunas) on movimentacao_estoque to authenticated` | 1, 2, 3, 5, 8, 12 |
| 6. `revoke select on itens_pedido from authenticated` | o arquivo aborta com `permission denied for table itens_pedido` |
| 7. `revoke execute on baixar_estoque_organizacao from service_role` | o arquivo aborta com `permission denied for function baixar_estoque_organizacao` |

Rodada base: 28/28. Depois de reverter tudo: 28/28.

A primeira rodada mostrou dois ajustes, ambos feitos no teste antes do commit:
- **Recusa por RLS:** a sabotagem 1 passava nos casos 1-3 porque a RLS também responde 42501. Os blocos agora exigem a recusa por privilégio.
- **pgTAP em `public`:** o caso 17 dependia de onde a extensão é instalada. Funções de extensão agora ficam de fora.

### Riscos residuais

- **Banco remoto:** a 81 só vale depois de aplicada, e as 75–80 podem não estar lá. Siga o runbook.
- **Tabela nova:** os privilégios padrão de `supabase_admin` concedem ALL a `anon`/`authenticated` em tabela criada por ele. Uma tabela nova precisa de revogação explícita na própria migration; o `catalog_security` cobre que toda tabela gravável tenha RLS.
- **SEC-01 fora do escopo comercial:** pela leitura do SQL, sem medição neste ticket, migrations antigas também concedem DML a `authenticated` em `titulos_financeiros`, `contas_financeiras`, `categorias_financeiras`, `fornecedores`, `documentos_fiscais`, `conexoes_integracao` e `organizacoes`. Algumas podem ter sido revogadas depois. Pertencem aos tickets donos (PRE-007A, PRE-008 e fiscal/integrações).
- **Decisões do PRE-006C:** seguem pendentes e não mudam aqui (capacidade do SAC, venda manual por `member`, contato recriado pelo SAC, PUT em pedido `#MANUAL-`).
- **E2E:** não executado, porque não há ambiente E2E descartável (as specs rodam contra o ambiente publicado e o Bling real). A evidência é o laboratório mais os testes de rota e de tela.
