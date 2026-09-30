# Foto do produto: Storage, provisionamento e validação

A foto personalizada do produto é uma propriedade local do ORBITA. Esta nota
registra como ela depende do Supabase Storage, o que o laboratório local
consegue provar, o que só o Storage real prova, e o roteiro de validação no
staging.

## Modelo

- Bucket privado `produto-imagens`: JPEG, PNG e WebP, até 5 MB por objeto.
  A configuração vive em `src/lib/config/produtoImagemBucket.json`, lido pelo
  contrato TypeScript e pelo script de provisionamento.
- O banco guarda só o caminho: `produtos.imagem_storage_path`
  (migration 70), no formato `<organizacao_id>/<produto_id>/<uuid>.<ext>`.
  A restrição `chk_produto_imagem_storage_path` prende o caminho à própria
  linha.
- `imagem_url` continua sendo o espelho do Bling. As leituras da tela
  (`/api/dashboard` e `/api/produtos`) devolvem em `imagem_url` a imagem efetiva:
  a foto do ORBITA por URL assinada, senão a do Bling, senão nada (placeholder).
- Upload direto do navegador para o Storage, com token de `createSignedUploadUrl`
  emitido pelo servidor para um caminho que o servidor gerou. Nenhuma rota do
  ORBITA recebe os bytes.
- Nenhuma policy em `storage.objects`: sem policy, `anon` e `authenticated` não
  leem nem escrevem nada no bucket. Upload por token assinado e leitura por URL
  assinada não dependem de policy.

## Provisionamento

A aplicação nunca cria bucket. O script é idempotente e somente leitura por
padrão:

```bash
SUPABASE_SERVICE_ROLE_KEY=... npm run storage:status  -- --url https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=... npm run storage:aplicar -- --url https://<ref>.supabase.co --confirmar
```

`status` informa se o bucket falta ou diverge (público, limite ou tipos).
`aplicar --confirmar` cria ou ajusta pela API oficial e confere pela releitura.
Uma segunda execução encontra o bucket em conformidade e não escreve nada.

Ordem no ambiente: aplicar as migrations 70 e 71 (`npm run db:remoto:aplicar`),
provisionar o bucket e, só depois, publicar o código. Sem o bucket, as leituras
continuam funcionando (a assinatura falha e cai para a imagem do Bling, com
registro no log), e as rotas de foto respondem `ArmazenamentoIndisponivel`.

Rollback: o código anterior ignora a coluna nova. Não há rollback de dados; a
remoção da coluna, se um dia for necessária, é uma migration nova depois que
nenhuma versão do código a ler.

## O que o laboratório local prova

O laboratório (`npm run test:db`) sobe só o Postgres, com Storage desabilitado
em `supabase/config.toml`. Ele prova:

- as migrations 70 e 71 se aplicam em ordem sobre a cadeia canônica, e o
  catálogo (`database/catalog-reference.json`) muda em exatamente uma coluna e
  uma restrição;
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

1. o bucket recusa, no upload assinado, tipo fora da lista e objeto acima de 5 MB;
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

1. `npm run db:remoto:status`, depois `db:remoto:aplicar --confirmar`: 70 e 71 aplicadas.
2. `npm run storage:status`, depois `storage:aplicar --confirmar`, e `storage:status`
   de novo: "em conformidade".
3. Com uma conta `owner`, abrir um produto já salvo e adicionar uma foto JPEG
   pequena: a miniatura da tabela muda sem recarregar a página.
4. Trocar por uma PNG: no Storage, o objeto anterior sumiu e o novo existe no
   prefixo `<org>/<produto>/`.
5. Abrir o mesmo produto em duas abas e trocar nas duas: a segunda mostra a
   mensagem de conflito, e só um objeto novo fica no prefixo.
6. Remover a foto: volta a imagem do Bling (ou o placeholder) e o objeto some.
7. Tentar enviar um GIF, um arquivo de 6 MB e, pelo console, confirmar um
   caminho de outra organização: as recusas respectivas, sem nada gravado.
8. Com uma conta `member` (sem `organization:manage`): os controles respondem
   "Apenas quem administra…" e nada é gravado.
9. Rodar uma sincronização do Bling: `imagem_url` pode mudar e
   `imagem_storage_path` continua igual (conferir por consulta somente leitura).
10. Conferir em `eventos_auditoria` os dois eventos, com metadata só de
    `produto_id`, `substituiu_anterior` e `limpeza_anterior`.

## Limitação conhecida

Um upload autorizado que nunca é confirmado (aba fechada no meio) deixa um
objeto órfão no prefixo do produto. Ele não é referenciado nem exibido. A
varredura desses órfãos fica para uma entrega futura.
