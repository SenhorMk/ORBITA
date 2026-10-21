# Inventário da escrita direta — títulos, fornecedores, contas e categorias financeiras (PRE-007A)

Escopo: `titulos_financeiros`, `fornecedores`, `contas_financeiras` e
`categorias_financeiras`. Base: `main` em `ce6144b`. Migration
`database/82_revogar_dml_direto_financeiro.sql` (ordem 85 do ledger).
Runbook: [`docs/operations/pre-007a-runbook.md`](../operations/pre-007a-runbook.md).

Entrega em duas fatias (expand/contract), porque a `main` é publicada no Staging automaticamente:
- **fatia 1 — banco** (`fix/pre-007a-banco`): a 82, o ledger, o catálogo, o pgTAP, os detectores e esta documentação. Não muda o comportamento da aplicação;
- **fatia 2 — código** (`fix/pre-007a-codigo`): as correções de título passam a usar as RPCs auditadas. Só entra depois de a 82 estar aplicada.

Fontes, todas executadas:
- código em `src/`: varredura de `.from(...)`/`.rpc(...)`, do cliente do navegador, do cliente com a sessão do usuário e das rotas;
- laboratório descartável (Windows, Docker) com a cadeia canônica 01–81 (antes) e 01–82 (depois).

Nada foi executado em banco remoto.

As regras viram teste em dois lugares:
- `src/lib/escritaDiretaFinanceira.test.ts`: o que o navegador e o servidor fazem;
- `supabase/tests/final/escrita_direta_financeira.test.sql` (39 casos): o que o banco concede.

## 1. Navegador (chave anônima + sessão do usuário)

O navegador **não lê nem grava** nenhuma das quatro tabelas e não chama RPC
do banco. As telas financeiras (`src/components/financeiro/*`) falam só com
as rotas da seção 2, por `fetchWithAuth`. O cliente com a sessão do usuário
no servidor (`createActorScopedSupabaseClient`) também não toca as quatro.

**Realtime:** nenhuma das quatro tabelas está publicada.

## 2. Servidor (service role, escopo verificado)

| Rota / caller | Tabelas escritas | Sessão + organização | Capacidade | Zod | Auditoria |
|---|---|---|---|---|---|
| `POST /api/financeiro` (lançar despesa, quitação opcional) | `titulos_financeiros` (`upsertTitulo`) | contexto verificado | `organization:manage` | `despesaRequestSchema` | ledger `tentativas_conta_pagar`/`baixas_conta_pagar` gravado **antes** do POST ao Bling; sem a tentativa reivindicada, o Bling não é chamado |
| `POST /api/financeiro/operacoes/{ref}/{quitacao,confirmacao-manual,reconciliar}` | `titulos_financeiros` (RPC `marcar_titulo_pago_conta_pagar`, só `service_role`) | `autorizarCorrecaoOperacional` | `organization:manage` | sim | recibo imutável `reconciliacoes_conta_pagar` com `ator_id` |
| `POST /api/financeiro/titulos/{id}/exclusao` | `titulos_financeiros` (RPC **`excluir_lancamento_interno_auditado`**, fatia 2; antes, DELETE direto) | `autorizarCorrecaoOperacional` | `organization:manage` | id UUID | **`finance.entry_deleted` na mesma transação (fatia 2)**; antes, gravado depois e sem abortar |
| `POST /api/financeiro/titulos/{id}/cancelamento` | `titulos_financeiros` (RPC **`cancelar_despesa_local_auditada`**, fatia 2; antes, UPDATE direto) | `autorizarCorrecaoOperacional` | `organization:manage` | id UUID | **`finance.expense_cancelled` na mesma transação (fatia 2)**; `finance.remote_reconcile_required` sem mutação local |
| `POST /api/financeiro/sync` | `titulos_financeiros` (espelho do Bling, `upsertTitulo` + `vincularPedidos`) | escopo verificado | membership (decisão do ticket 22) | parse do Bling | checkpoint em `sync_state`; o gatilho `tg_titulo_conta_pagar_pago_so_comprovado` impede que a sincronização marque como pago um título do PRE-002 sem comprovação |
| `POST /api/financeiro/fornecedores` | nenhuma das quatro (cria contato **no Bling**) | escopo verificado | membership (decisão do ticket 22) | não (corpo tipado à mão) | — |
| `GET /api/financeiro`, `GET /api/financeiro/fornecedores`, `GET /api/financeiro/operacoes*` | — (leitura) | escopo verificado | membership | — | — |

`fornecedores`, `contas_financeiras` e `categorias_financeiras` **não têm
gravador no produto**: a única escrita delas é de migrations e backfills
(`service_role`). Gravador direto do servidor nas quatro tabelas existe um só,
`src/repositories/financeiroRepository.ts` → `titulos_financeiros`, e o teste
fixa essa lista.

Funções do banco que escrevem nas quatro tabelas, todas executáveis **só**
por `service_role` ou rodando como gatilho (medido depois da 82):
- `excluir_lancamento_interno_auditado`, `cancelar_despesa_local_auditada` (novas);
- `marcar_titulo_pago_conta_pagar` (PRE-002);
- `registrar_venda_manual`;
- `fn_converge_titulos_do_pedido_cancelado`: gatilho de `pedidos`, que o navegador já não grava desde a 81;
- backfills de tenancy: `executar_backfill_financeiro_organizacao`, `migrar_financeiro_para_organizacoes`, `quarentenar_registros_financeiros_sem_tenant`.

## 3. Banco — matriz de privilégios efetivos (`has_table_privilege`)

Legenda: S = SELECT, I = INSERT, U = UPDATE, D = DELETE, T = TRUNCATE.

| Tabela | Papel | Antes (01–81) | Depois (01–82) |
|---|---|---|---|
| as quatro | `authenticated` | S I U D (57 colunas graváveis: 20 + 17 + 12 + 8) | **S** (0 colunas) |
| as quatro | `anon` | — | — |
| as quatro | PUBLIC (ACL) | — | — |
| as quatro | `service_role` | S I U D T | S I U D T |

**Policies:** antes e depois, as 16 `*_org_{select,insert,update,delete}` são
de `authenticated` e isolam só por `usuario_pertence_a_organizacao`. Na cadeia
canônica não sobrou nenhuma policy com o ramo `user_id = auth.uid()`: a
migration 45 já tinha trocado as da migration 24.
- A 82 remove pelo nome as policies legadas, se tiverem sobrevivido num banco que divergiu: `Acesso a <tabela> por organizacao ou user`, `Enable all access for <tabela>`, `Isolamento por tenant`.
- A autoverificação da 82 aborta se qualquer policy das quatro tiver ramo `auth.uid()` ou outro papel.
- As de escrita ficam, sem grant que as alcance, como segunda barreira (mesma decisão do PRE-006D).

## Achados

1. **Corrigido — DML financeiro direto pelo PostgREST.** Antes da 82,
   qualquer membro (inclusive `member`) podia, com o próprio token:
   - alterar o `valor` de um título da própria organização (provado no laboratório: o UPDATE passou);
   - forjar título pago;
   - apagar despesas, fornecedores, contas e categorias.

   Nada disso passava pela capacidade `organization:manage`, pela auditoria ou pelo ledger do PRE-002.

   A tentativa de marcar como pago um título vinculado a uma operação do
   PRE-002 respondia `42501`, mas por acaso: o gatilho do PRE-002 lê
   `tentativas_conta_pagar`, que `authenticated` não lê. O mesmo acontecia
   numa alteração de valor depois que o plano do gatilho ficava em cache.
   Nenhuma das duas recusas era controle de acesso. O teste exige agora a
   recusa por privilégio na própria tabela.
2. **Corrigido na fatia 2 — auditoria das correções de título era posterior e opcional.**
   - `excluir lançamento` apagava a linha e só depois tentava gravar `finance.entry_deleted`. Se a trilha falhasse, a exclusão de um registro financeiro ficava sem rastro.
   - O cancelamento local seguia o mesmo padrão.
   - Na fatia 2, as duas mutações passam a ser RPCs que gravam o evento na mesma transação: se `registrar_evento_auditoria` recusar (ator sem membership, organização inexistente), nada muda.
   - A situação anterior no evento é a da linha alterada, não a que o servidor leu antes.
3. **Para decisão (sem mudança aqui):**
   - `POST /api/financeiro/sync` e `POST /api/financeiro/fornecedores` exigem só membership, por decisão testada do ticket 22 (`ticket-22-fronteira-financeira.test.ts`).
   - A sincronização é o espelho do Bling, a autoridade do valor e da situação, e não marca como pago título do PRE-002 sem comprovação.
   - O cadastro de fornecedor cria contato no Bling, fora das quatro tabelas, sem Zod nem auditoria.
   - Exigir `organization:manage` em qualquer dos dois é uma linha por rota e uma mudança no teste do ticket 22.
4. **Fora do escopo:** `documentos_fiscais`, `conexoes_integracao` e `organizacoes` (PRE-008 e fiscal/integrações).

## Matriz de efeitos externos (17 casos)

O PRE-007A não cria efeito externo novo. O cancelamento continua indo ao Bling
exatamente como antes (leitura, `DELETE` confirmado, `excluirComConfirmacao`).
Na fatia 2, só a conclusão **local** muda de forma, e o cancelamento ganha uma sonda antes do Bling:

| Caso | Tratamento |
|---|---|
| 1–9, 12–17 | inalterados: ver `correcaoDeTitulo.ts` e os testes `correcao-de-titulo.test.ts` (timeout, 404, 5, 2, ambíguo, recusa, retry após ACK perdido) |
| 10 Crash depois do efeito remoto · 11 crash antes do commit | a conclusão local é uma transação: ou o título vira `cancelado` **com** o evento, ou nada muda. A resposta é `ReconcileRequired`/`conclusao_local_pendente`, e repetir converge (o Bling já responde 404, sem novo `DELETE`) |
| Auditoria recusada | igual ao 11: nada local muda; a exclusão interna responde 500 genérico sem apagar |
| 1 Antes do envio, banco sem a 82 | a sonda (`cancelar_despesa_local_auditada` com argumentos nulos → `22023` só se a função existe) falha, e o cancelamento responde `Unavailable` (503) sem chamar o Bling |

## Testes que provam

| Prova | Onde |
|---|---|
| Browser não marca pago nem altera montante | pgTAP 4, 5, 7 (recusa por privilégio na própria tabela) e 13 (nenhuma coluna gravável) |
| Owner/admin/member de A e anon sem DML; tabelas idênticas por hash | pgTAP 1–3, 6, 8, 9 |
| Membro de outra organização | pgTAP 7 (owner de B sobre A), 21 (não lê B), 27 (a RPC com a organização B não exclui título de A) |
| Fluxo autorizado | pgTAP 29–30, 33–34 e 36 (o repositório do servidor grava); `correcao-de-titulo.test.ts`; despesa vinculada a pedido não é cancelada pela RPC (35) |
| Falha de auditoria aborta a mutação | pgTAP 25–26 (exclusão) e 32–34 (cancelamento); `correcao-de-titulo.test.ts` ("falha da auditoria aborta…"); `correcao-operacional-escopo.test.ts` (erro do banco não vira "zero linhas") |
| Entrada inválida | pgTAP 31 (evidência fora do contrato → `22023`); id não UUID → 400 (inalterado) |
| Usuário sem capacidade | `correcao-de-titulo.test.ts` ("sem capability"), `ticket-22-*` (inalterados) |
| Leitura conforme papel | pgTAP 20–22 |
| Navegador e sessão do usuário sem acesso; gravadores do servidor fixados | `escritaDiretaFinanceira.test.ts` |
| PRE-002 continua (marcação × sincronização) | `npm run test:db`, ensaio de concorrência da reconciliação |
| A `main` sem a fatia 2 continua compatível com a 82 | pgTAP 37–38 (DELETE/UPDATE diretos das correções de título, com `service_role`) e o `test:db` completo com a 82 |
| A sonda não tem efeito | pgTAP 39 (argumentos nulos → `22023` antes de qualquer leitura ou escrita) |

**Contraprovas SQL** foram rodadas no laboratório. Cada sabotagem foi aplicada
dentro da transação do teste e desfeita pelo `rollback`, e o ACL e as funções
foram conferidos por hash, iguais no fim.

| Sabotagem | Detectada por |
|---|---|
| `grant update on titulos_financeiros to authenticated` | 1–5, 7, 10, 13 |
| `grant update (situacao) on titulos_financeiros to authenticated` | 4, 13 |
| `grant insert on fornecedores to authenticated` | 1–3, 10, 13 |
| `grant execute on excluir_lancamento_interno_auditado to authenticated` | 17, 23 |
| exclusão sem a chamada de auditoria | 25, 26, 29, 30 |
| policy legada com `auth.uid()` recriada | 15 |
| `grant execute on marcar_titulo_pago_conta_pagar to authenticated` | 17, 24 |
| cancelamento sem a chamada de auditoria | 31–34 |
| cancelamento sem conferir `pedido_id` | 35 |
| cancelamento falhando por outro erro que não a auditoria | 32 |
| a 82 **sem o REVOKE**, aplicada sobre S84 | a própria migration aborta: `P0001 PRE-007A: authenticated ainda escreve em public.titulos_financeiros` |
| a 82 sem o REVOKE **e** sem a autoverificação | aplica, e o pgTAP derruba 1–7, 9, 10, 13 e 20 |
| `revoke select on titulos_financeiros from authenticated` | o arquivo aborta (`permission denied for table titulos_financeiros`) |
| `revoke execute on excluir_lancamento_interno_auditado from service_role` | o arquivo aborta (`permission denied for function …`) |

A primeira rodada mostrou três furos no próprio teste, corrigidos antes do commit:
- um 42501 de outra tabela, `tentativas_conta_pagar`, contava como negação;
- os casos 23 e 24 aceitavam um 42501 da tabela em vez da função.

**Contraprovas de aplicação (fatia 2):** sete sabotagens, todas detectadas, com os arquivos restaurados idênticos.
- cancelamento sem a sonda antes do Bling;
- sonda que aceita qualquer erro diferente de `PGRST202`;
- `DELETE` direto no repositório;
- auditoria depois do efeito;
- falha da auditoria engolida;
- navegador gravando `titulos_financeiros`;
- erro do banco devolvido como zero linhas.

## Riscos residuais

- **Ordem de implantação** (ver o runbook, seção 1, com GO/NO-GO por passo e a matriz S77–S85 × main/fatia 1/fatia 2 provada com o ledger cortado): Marco A → Marco B → mesclar a fatia 1 → aplicar a 82 pela `main` → mesclar a fatia 2.
  - A fatia 1 não muda o código publicado; com ou sem a 82 ele é compatível.
  - Se a fatia 2 for publicada sem a 82 por engano, o cancelamento recusa antes do Bling (`Unavailable`), e a exclusão responde 500 sem apagar.
- **Banco remoto:** a 82 só vale depois de aplicada, e só pode ser aplicada depois dos Marcos A (75–80) e B (81).
- **Data API:** a negação foi provada no Postgres com os papéis e claims que o PostgREST usa (`set role authenticated` + `request.jwt.claim.*`), sem subir o PostgREST: o `[api]` do laboratório está desligado.
- **E2E:** não executado; não há ambiente E2E descartável.
- **Validação de catálogo no TypeScript:** os dois eventos agora são gravados pelo SQL, com metadata fixa (`situacao_anterior`, `origem`, `bling_id`, `evidencia`), sem passar por `assertValidCatalogEvent` nem pela redação do `auditService`. Hoje não há impacto: as chaves são as mesmas de antes e nenhuma é dado pessoal. Uma regra nova de campo proibido em `auditEventCatalog.ts` não alcançaria esses dois eventos.

## Revisão independente

Um revisor leu o commit e não achou defeito bloqueante. Dois pontos foram corrigidos antes do merge:
- o caso 26 somava contagens e podia passar com "linha apagada + evento"; agora compara `1:0`;
- os casos 25 e 32 aceitavam qualquer `P0001`; agora exigem a recusa anti-forjamento.

Também por indicação da revisão, `cancelar_despesa_local_auditada` passou a conferir `pedido_id is null`, como a exclusão, e falha fechada se o título ganhou vínculo com pedido depois da leitura (caso 35).
