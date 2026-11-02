# Inventário da escrita direta — documentos fiscais (PRE-007B)

Escopo: `documentos_fiscais`, a única tabela fiscal do schema. `nfes` saiu na
migration 16. Base: `fix/pre-007a-banco` (`05361c2`, PR #118), sobre a `main`
`ce19a9a`. Migration `database/83_revogar_dml_direto_fiscal.sql` (ordem 86 do
ledger). Runbook: [`docs/operations/pre-007b-runbook.md`](../operations/pre-007b-runbook.md).

Entrega em duas fatias (expand/contract), porque a `main` é publicada no Staging automaticamente:
- **fatia 1 — banco** (`fix/pre-007b-banco`): a 83, o ledger, o catálogo, o pgTAP, os detectores e esta documentação. Não muda o comportamento da aplicação. A única linha fora de testes em `src/` é o evento `fiscal.document_issued` no catálogo `auditEventCatalog.ts`, exigido pelo teste de paridade com `catalogo_eventos_auditoria`. Nenhum código o emite antes da fatia 2;
- **fatia 2 — código** (`fix/pre-007b-codigo`): o registro local da NF-e emitida passa a usar a RPC auditada, e a emissão sonda a RPC antes do Bling. Só entra depois de a 83 estar aplicada.

**Por que existe a fatia 2.** Nenhum caller escreve com o token do usuário, então a revogação não depende dela. Ela existe por um critério de aceite do ticket: a emissão legítima deve continuar "com evidência auditada". Hoje `POST /api/nfe` não grava nenhum evento de auditoria. Se esse critério for dispensado, a fatia 1 fica de pé sozinha, e a RPC passa a não ter caller.

Fontes, todas executadas:
- código em `src/`: varredura de `.from(...)`/`.rpc(...)`, do cliente do navegador, do cliente com a sessão do usuário e das rotas;
- laboratório descartável (Windows, Docker) com a cadeia canônica 01–82 (antes) e 01–83 (depois).

Nada foi executado em banco remoto.

As regras viram teste em dois lugares:
- `src/lib/escritaDiretaFiscal.test.ts`: o que o navegador e o servidor fazem;
- `supabase/tests/final/escrita_direta_fiscal.test.sql` (36 casos): o que o banco concede.

## 1. Navegador (chave anônima + sessão do usuário)

O navegador **não lê nem grava** `documentos_fiscais`, nem por `.from`, nem
por embed, e não chama RPC do banco. A tela que fatura (`src/app/page.tsx`)
chama `POST /api/nfe` por `fetchWithAuth`. A NF-e exibida vem do embed
`nfe:documentos_fiscais` que `pedidoRepository` monta no servidor. O cliente
com a sessão do usuário (`createActorScopedSupabaseClient`) não toca a tabela.

**Realtime:** a tabela não está publicada.

## 2. Servidor (service role, escopo verificado)

| Rota / caller | Acesso | Sessão + organização | Capacidade | Zod | Auditoria |
|---|---|---|---|---|---|
| `POST /api/nfe` (faturar) | lê a NF-e do pedido; grava com `pedidoRepository.upsertNfe` (fatia 1: upsert direto; fatia 2: RPC **`registrar_documento_fiscal_emitido`**) | escopo verificado | `organization:manage` | não (corpo `{pedidoId, blingPedidoId}` lido à mão) | **fatia 2: `fiscal.document_issued` na mesma transação**; antes, nenhuma |
| `GET` de pedidos (`pedidoRepository.getAllEnriched`) | lê pelo embed `nfe:documentos_fiscais` | escopo verificado | membership | — | — |

Há um único gravador direto do servidor: `src/repositories/pedidoRepository.ts`.
O único caller dele é `POST /api/nfe`. O teste fixa as duas coisas, além da
capacidade da rota. A capacidade é atravessada pela rota real em
`ticket-22-fronteira-fiscal.test.ts`: o `member` recebe 403 e o Bling não é chamado.

Funções do banco que citam `documentos_fiscais`, medidas depois da 83. Nenhuma é executável por `authenticated` ou `anon`:
- `registrar_documento_fiscal_emitido` (nova, só `service_role`);
- `migrar_comercial_para_organizacoes`, `executar_backfill_catalogo_comercial_organizacao` e `verificar_integridade_baseline` (backfills e verificação de tenancy);
- os gatilhos `trg_sync_documentos_fiscais_organizacao` (recusa pedido de outra organização com `23503`) e `tg_documentos_fiscais_updated_at`.

## 3. Banco — matriz de privilégios efetivos (`has_table_privilege`)

| Papel | Antes (01–82) | Depois (01–83) |
|---|---|---|
| `authenticated` | S I U D (17 colunas graváveis) | **S** (0 colunas) |
| `anon` | — | — |
| PUBLIC (ACL) | — | — |
| `service_role` | S I U D T | S I U D T |

**Policies:** antes e depois, as quatro `documentos_fiscais_org_{select,insert,update,delete}`
são de `authenticated` e isolam só por `usuario_pertence_a_organizacao`. Na
cadeia canônica não sobrou nenhuma com `auth.uid()`: a 32 trocou a da 23.
- A 83 remove pelo nome as legadas, se tiverem sobrevivido num banco que divergiu: `Acesso a documentos_fiscais por organizacao ou user`, `Enable all access for documentos_fiscais`, `Isolamento por tenant`.
- A autoverificação da 83 aborta se alguma policy tiver ramo `auth.uid()` ou outro papel.
- As de escrita ficam, sem grant que as alcance, como segunda barreira (mesma decisão do PRE-006D e do PRE-007A).

## Achados

1. **Corrigido — DML fiscal direto pelo PostgREST.** Antes da 83, qualquer membro, inclusive `member`, podia com o próprio token:
   - inserir uma NF-e "Emitida" para um pedido;
   - cancelar uma nota ou trocar número e chave;
   - apagar notas da própria organização.

   Nada disso passava por `organization:manage`, pelo lock da emissão nem pelo Bling. Provado no laboratório: com o grant de volta, o INSERT do `member` passa (contraprova abaixo).
2. **Corrigido na fatia 2 — a emissão não deixava rastro.** `POST /api/nfe` gravava a nota sem evento de auditoria. Na fatia 2, `registrar_documento_fiscal_emitido` grava a nota e `fiscal.document_issued` na mesma transação. Se `registrar_evento_auditoria` recusar, nada local muda e a rota responde como numa falha de banco: 500 com `compensation_required`, número e chave para reconciliar. O metadata leva só ids técnicos, situação e operação (`inserido`/`atualizado`), nunca a chave de acesso.
3. **Para decisão (sem mudança aqui):**
   - Os índices únicos legados `uq_idx_documentos_fiscais_tenant_bling (user_id, bling_id)` e `uq_idx_documentos_fiscais_tenant_pedido (user_id, pedido_id)` são por usuário, não por organização. A unicidade "uma NF-e por pedido" depende do lock e da consulta da rota, não do banco. Trocar exige migration com verificação de duplicatas: ticket próprio.
   - O corpo de `POST /api/nfe` não passa por Zod. Um `pedidoId` que não é UUID falha já no lock (`22P02`), e a rota responde 429 "outra emissão em andamento", o que engana quem lê, mas sem efeito no Bling nem no banco.
4. **Fora do escopo:** `conexoes_integracao` e `organizacoes` (PRE-008 e integrações).

## Matriz de efeitos externos (17 casos)

O PRE-007B não cria efeito externo novo. A emissão continua indo ao Bling
exatamente como antes: lock, consulta local, `createNfe` uma vez. Na fatia 2
mudam só duas coisas: o registro **local** vira uma transação com a
auditoria, e há uma sonda antes do Bling.

| Caso | Tratamento |
|---|---|
| 1 Antes do envio, banco sem a 83 | a sonda (`registrar_documento_fiscal_emitido` com argumentos nulos → `22023` só se a função existe) falha, e a rota responde 503 sem chamar o Bling |
| 2–9, 12–17 | inalterados: lock por organização e pedido (429 em concorrência), consulta local antes do Bling (400 se já há nota), resposta sem identificador → 502 `compensation_required` |
| 10 Crash depois do efeito remoto · 11 crash antes do commit | o registro local é uma transação: ou a nota fica **com** o evento, ou nada fica. A resposta é 500 `compensation_required` com número e chave, como antes |
| Auditoria recusada | igual ao 11 |
| Replay com o mesmo identificador do Bling | o upsert por `(organizacao_id, bling_id)` atualiza a mesma linha e o evento registra `atualizado` (pgTAP 31–32) |

## Testes que provam

| Prova | Onde |
|---|---|
| Browser não forja, não cancela, não apaga nota | pgTAP 1–6 (recusa por privilégio na própria tabela) e 12 (nenhuma coluna gravável) |
| anon sem DML; tabela idêntica por hash | pgTAP 7, 8 |
| Membro de outra organização | pgTAP 6 (owner de B sobre A), 20 (não lê B), 25 (a RPC com a organização B e o pedido de A → `23503`) |
| Usuário sem capability | pgTAP 3–5 (`member` sem DML); `ticket-22-fronteira-fiscal.test.ts` (rota: `member` → 403, Bling não chamado) |
| Entrada inválida | pgTAP 26–28 (pedido nulo, número em branco → `22023`; situação fora do contrato → `23514`) |
| Fluxo autorizado e auditado | pgTAP 29–30 (nota na organização, com o ator, e um evento sem a chave); fatia 2: `nfe-registro-auditado.test.ts` |
| Falha de auditoria aborta a mutação | pgTAP 23–24 (nota nova: a falha tem de ser a recusa anti-forjamento, `P0001` com a mensagem exata; depois, `0:0`: nem nota, nem evento) e 34–35 (nota existente: a mesma recusa, e a linha fica idêntica por hash, sem evento) |
| Leitura conforme papel | pgTAP 19–21 |
| Navegador e sessão do usuário sem acesso; gravador e caller fixados | `escritaDiretaFiscal.test.ts` |
| A `main` sem a fatia 2 continua compatível com a 83 | pgTAP 33 (upsert direto com `service_role`) e o `test:db` completo |
| A sonda não tem efeito | pgTAP 36 |

**Contraprovas SQL**, rodadas no laboratório. Cada sabotagem foi aplicada
dentro da transação do teste e desfeita pelo `rollback`.

| Sabotagem | Detectada por |
|---|---|
| `grant insert on documentos_fiscais to authenticated` | 1–4, 8, 9, 12, 19 |
| `grant update (status) on documentos_fiscais to authenticated` | 5, 6, 8, 12 |
| `grant delete on documentos_fiscais to anon` | 7, 10 |
| `grant execute on registrar_documento_fiscal_emitido to authenticated` | 16, 22 |
| registro sem a chamada de auditoria | 23, 24, 30, 32, 34, 35 |
| registro falhando por outro erro (divisão por zero no lugar da auditoria) | 23: a falha não é a recusa esperada |
| policy legada com `auth.uid()` recriada | 14 |
| a 83 **sem o REVOKE**, aplicada sobre S85 | a própria migration aborta: `P0001 PRE-007B: authenticated ainda escreve em public.documentos_fiscais` |
| a 83 sem o REVOKE **e** sem a autoverificação | aplica, e o pgTAP derruba 1–6, 8, 9, 12 e 19 |

**Contraprovas dos detectores** (Vitest), com os arquivos restaurados idênticos:
- navegador gravando `documentos_fiscais`;
- gravador novo no servidor;
- `POST /api/nfe` sem `organization:manage`.

**Contraprovas de aplicação (fatia 2):** cinco sabotagens, todas detectadas, com os arquivos restaurados idênticos.
- emissão sem a sonda antes do Bling;
- sonda que aceita qualquer erro diferente de `PGRST202`;
- upsert direto no repositório;
- falha da auditoria engolida;
- correlação da requisição ignorada.

## Riscos residuais

- **Ordem de implantação:** ver o runbook. Merge do #118 → aplicar a 82 → validar → mesclar a fatia 1 → aplicar a 83 → validar → mesclar a fatia 2.
- **Data API:** a negação foi provada no Postgres com os papéis e claims que o PostgREST usa (`set role authenticated` + `request.jwt.claim.*`), sem subir o PostgREST: o `[api]` do laboratório está desligado.
- **E2E:** não executado; não há ambiente E2E descartável, e a emissão real exige o Bling.
- **A sonda só prova que a função existe.** Ela recusa os argumentos nulos antes de tocar `registrar_evento_auditoria` ou o catálogo. Se a auditoria falhar por outro motivo depois da emissão, por exemplo a membership do ator revogada durante a requisição, a nota sai no Bling e a rota cai no 500 `compensation_required`. É o mesmo desenho do PRE-007A, e o mesmo desfecho de antes para qualquer falha de banco depois do Bling.
- **Catálogo no TypeScript:** o evento é gravado pelo SQL, com metadata fixa (`bling_id`, `pedido_id`, `status`, `operacao`), sem passar por `assertValidCatalogEvent`. Os campos proibidos declarados no catálogo (`chave_acesso`, `xml_url`, `danfe_url`) não chegam ao metadata; o pgTAP 30 confere a ausência da chave.
