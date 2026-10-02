# Foto do produto: Storage, provisionamento e validação

A foto personalizada do produto é uma propriedade local do ORBITA. Esta nota
registra como ela depende do Supabase Storage, o que o laboratório local
consegue provar, o que só o Storage real prova, e o roteiro de validação no
staging.

## Modelo

- Bucket privado `produto-imagens`: JPEG, PNG e WebP, até 3 MB por objeto (o limite
  por imagem do Bling).
  A configuração vive em `src/lib/config/produtoImagemBucket.json`, lido pelo
  contrato TypeScript e pelo script de provisionamento.
- O banco guarda só o caminho: `produtos.imagem_storage_path`
  (migration 70), no formato `<organizacao_id>/<produto_id>/<uuid>.<ext>`.
  A restrição `chk_produto_imagem_storage_path` prende o caminho à própria
  linha.
- `produtos.imagem_bling_sync_path` (migration 72) guarda a foto que o Bling
  confirmadamente tem. A sincronização ORBITA → Bling está em
  [foto-produto-sync-bling.md](foto-produto-sync-bling.md).
- `imagem_url` continua sendo o espelho do Bling. As leituras da tela
  (`/api/dashboard` e `/api/produtos`) devolvem em `imagem_url` a imagem efetiva:
  a foto do ORBITA por URL assinada; sem foto, a do Bling só se o ORBITA nunca
  adotou a imagem do produto; senão nada (placeholder). Ver
  [foto-produto-sync-bling.md](foto-produto-sync-bling.md).
- Upload direto do navegador para o Storage, com token de `createSignedUploadUrl`
  emitido pelo servidor para um caminho que o servidor gerou. Nenhuma rota do
  ORBITA recebe os bytes.
- Nenhuma policy em `storage.objects`: sem policy, `anon` e `authenticated` não
  leem nem escrevem nada no bucket. Upload por token assinado e leitura por URL
  assinada não dependem de policy.

## Provisionamento

A aplicação nunca cria bucket. O script é idempotente e somente leitura por
padrão. A chave de service-role vem só da variável de ambiente
`SUPABASE_SERVICE_ROLE_KEY`, definida no shell a partir do cofre de segredos —
nunca como argumento e nunca escrita em arquivo:

```bash
npm run storage:status  -- --url https://<ref>.supabase.co
npm run storage:aplicar -- --url https://<ref>.supabase.co --confirmar
```

`status` informa se o bucket falta ou diverge (público, limite ou tipos).
`aplicar --confirmar` cria ou ajusta pela API oficial e confere pela releitura.
Uma segunda execução encontra o bucket em conformidade e não escreve nada.

Ordem no ambiente: aplicar as migrations 70, 71 e 72 (`npm run db:remoto:aplicar`),
provisionar o bucket e, só depois, publicar o código. Sem o bucket, as leituras
continuam funcionando (a assinatura falha e o produto com foto mostra o placeholder, com
registro no log), e as rotas de foto respondem `ArmazenamentoIndisponivel`.

Rollback: o código anterior ignora a coluna nova. Não há rollback de dados; a
remoção da coluna, se um dia for necessária, é uma migration nova depois que
nenhuma versão do código a ler.

## O que o laboratório local prova

O laboratório (`npm run test:db`) sobe só o Postgres, com Storage desabilitado
em `supabase/config.toml`. Ele prova:

- as migrations 70, 71 e 72 se aplicam em ordem sobre a cadeia canônica, e
  cada coluna nova (70 e 72) muda o catálogo
  (`database/catalog-reference.json`) em exatamente uma coluna e uma restrição;
- a restrição recusa caminho de outra organização, de outro produto, com
  travessia de diretório, e URL assinada
  (`supabase/tests/database/foto_personalizada_do_produto.test.sql`);
- o compare-and-set com precondição desatualizada, ou escopado em outra
  organização, não troca nada, e regravar `imagem_url` não toca a foto;
- duas transações reais trocando a partir da mesma foto: uma vence e a outra vê
  zero linhas, com a espera na trava observada em `pg_stat_activity`
  (`scripts/database-concurrency-foto-produto.mjs`);
- os eventos `catalog.product_image_uploaded` e `catalog.product_image_removed`
  existem na projeção SQL e são gravados pela RPC de auditoria.

Os testes unitários (`npm test`) provam as regras das rotas contra fakes do
Storage e do banco que aplicam filtro por organização e precondição de verdade:
autorização, tenant, caminho gerado no servidor, adulteração, tipo e tamanho,
confirmação sem upload, conflito, ordem CAS antes da remoção, falha de limpeza,
idempotência, auditoria sem dado sensível, leitura efetiva e UI.

## O que exige o Storage real

O laboratório não executa a API do Storage. Estes comportamentos dependem do
serviço e precisam ser validados no staging:

1. o bucket recusa, no upload assinado, tipo fora da lista e objeto acima de 3 MB;
2. `createSignedUploadUrl(caminho, { upsert: false })` só aceita aquele caminho,
   e o token não sobrescreve objeto existente;
3. `info` de um objeto inexistente é classificado como ausente (o adapter
   aceita `404`, `statusCode: "404"` e mensagem "not found", porque a forma
   varia entre versões);
4. `createSignedUrls` em lote devolve uma URL por caminho, com a validade de uma hora;
5. o bucket é privado: a URL pública do objeto responde erro, e `anon` com a
   chave pública não lista nem lê objetos.

## Roteiro de validação no staging

Depende de autorização explícita para aplicar migrations, criar o bucket e
enviar arquivos ao projeto remoto.

1. `npm run db:remoto:status`, depois `db:remoto:aplicar --confirmar`: 70, 71 e 72 aplicadas.
2. `npm run storage:status`, depois `storage:aplicar --confirmar`, e `storage:status`
   de novo: "em conformidade".
3. Com uma conta `owner`, abrir um produto já salvo e adicionar uma foto JPEG
   pequena: a miniatura da tabela muda sem recarregar a página.
4. Trocar por uma PNG: no Storage, o objeto anterior sumiu e o novo existe no
   prefixo `<org>/<produto>/`.
5. Abrir o mesmo produto em duas abas e trocar nas duas: a segunda mostra a
   mensagem de conflito, e só um objeto novo fica no prefixo.
6. Remover a foto: o placeholder aparece (o produto continua gerenciado pelo
   ORBITA, então a imagem do Bling não volta) e o objeto some.
7. Tentar enviar um GIF, um arquivo de 4 MB e, pelo console, confirmar um
   caminho de outra organização: as recusas respectivas, sem nada gravado.
8. Com uma conta `member` (sem `organization:manage`): os controles respondem
   "Apenas quem administra…" e nada é gravado.
9. Rodar uma sincronização do Bling: `imagem_url` pode mudar e
   `imagem_storage_path` continua igual (conferir por consulta somente leitura).
10. Conferir em `eventos_auditoria` os dois eventos, com metadata só de
    `produto_id`, `substituiu_anterior` e `limpeza_anterior`.

## Exclusão de produto e a foto

Caminhos que removem uma linha de `public.produtos` (auditados; a guarda
`src/repositories/produto-exclusao-e-deduplicacao.test.ts` falha se surgir
outro chamador de `ProdutoRepository.delete` ou outro `delete` direto em
`produtos`):

| Caminho | Tratamento da foto |
|---|---|
| `POST /api/produtos/delete` | `excluirProdutoComFoto`: exclui a linha escopada por `id` + organização; o `DELETE ... RETURNING` devolve o `imagem_storage_path` da linha excluída; só então o objeto sai do Storage, depois de passar de novo por `caminhoPertenceAoProduto`. Exclusão local falhou → o arquivo fica. Limpeza falhou → a exclusão continua valendo, a resposta não muda, e a falha vai para o log (`produtos.delete.limpeza_da_foto`). Antes disso, se o produto tem `bling_id`, a exclusão no Bling precisa estar confirmada: situação `E`, `DELETE` e `GET` 404 (`excluirProdutoNoBling`). Sem confirmação, nada local é apagado. |
| Deduplicação por `bling_id` em `ProdutoRepository.upsert` | Ocorre em `POST /api/produtos/update` quando o produto editado (A) passa a apontar para um `bling_id` que já pertence a outra linha local (B). B com foto → nada é excluído nem gravado localmente; a gravação falha com `ReconciliacaoDeProdutoNecessaria` e a rota responde "Produto salvo no Bling (id …), mas falhou ao gravar no ORBITA … Sincronize o catálogo para reconciliar". A continua A, B continua B com a foto. B sem foto → `excluirDuplicadoSemFoto`, um `DELETE ... WHERE id AND organizacao_id AND imagem_storage_path IS NULL RETURNING id`: a decisão "sem foto" é da mesma instrução. Zero linhas → relê: ausente segue; com foto (confirmada no meio) é reconciliação; outro estado falha explicitamente. Erro de banco nesse `DELETE` (FK de pedido, por exemplo) também é reconciliação: A e B ficam como estão, sem `update` nem `upsert`, e a causa vai só para o log do servidor. A corrida confirmação × DELETE condicionado é provada com duas transações reais em `scripts/database-concurrency-foto-produto.mjs`. |
| `ON DELETE CASCADE` de `organizacoes` e de `auth.users` | Só a limpeza do E2E (`src/lib/e2e/supabasePorta.ts`) apaga organização ou usuário, e apenas os sintéticos da execução, que não enviam foto. Não há exclusão de organização no produto. Se um dia houver, ela precisa limpar o prefixo `<organizacao>/` do bucket. |
| Policy `produtos_org_delete` (RLS, `authenticated`) | Nenhum código do ORBITA exclui produto pelo cliente do navegador; o cliente só lê. Uma exclusão direta por PostgREST deixaria o objeto sem referência. |

## Dívida operacional: objetos sem referência

**Não resolvido.** Três situações deixam no bucket um objeto que nenhuma linha
referencia:

1. upload autorizado e enviado, mas nunca confirmado (aba fechada, rede caiu
   entre o envio e a confirmação);
2. limpeza que falhou depois de uma troca, remoção ou exclusão (registrada no
   log e, na troca e na remoção, na auditoria como `limpeza_anterior: falhou`);
3. as exclusões indiretas da tabela acima.

Nenhum deles é exibido nem acessível sem URL assinada, que só é emitida para
caminhos referenciados. O desenho permite identificá-los sem estado adicional:
todo objeto tem o caminho `<organizationId>/<productId>/<uuid>.<ext>`, então um
objeto é órfão quando **nenhuma** linha de `produtos` com aquele `id` e aquela
`organizacao_id` tem `imagem_storage_path` igual ao caminho — inclusive quando a
linha ou a organização já não existem.

Isso deve ganhar uma limpeza por idade: listar o bucket pela API do Storage,
considerar só objetos mais velhos que uma margem (por exemplo 24 horas, para
não apagar um upload ainda à espera de confirmação), conferir a referência no
banco e remover pela API. Até lá, os órfãos ocupam espaço e nada mais.
