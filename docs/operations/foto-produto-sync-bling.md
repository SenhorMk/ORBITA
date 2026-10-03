# Foto do produto: sincronização ORBITA → Bling

Como a foto escolhida no ORBITA chega ao produto vinculado no Bling. A foto
local e o Storage estão em [foto-do-produto-storage.md](foto-do-produto-storage.md).

## Regra de produto

- O ORBITA tem **uma** foto por produto. Galeria está fora do escopo.
- Enquanto o produto nunca recebeu foto no ORBITA, as imagens do Bling são do
  Bling e ficam intocadas.
- No primeiro upload, o ORBITA passa a ser dono do conjunto de imagens daquele
  produto no Bling:
  - adicionar A → o Bling termina só com A;
  - trocar para B → só B;
  - remover → nenhuma imagem. As imagens antigas não são restauradas.

## Contrato de mídia do Bling (fase A, provado na conta conectada)

Caracterizado em 2026-10-02 com um produto descartável
(`ORBITA_SANDBOX_TESTE_IMAGEM_NAO_USAR`), um experimento por chamada, sempre
relendo o produto. Os experimentos destrutivos não se repetem; este é o registro.

| Fato | Evidência |
|---|---|
| `PUT /produtos/{id}` **sem** `midia` apaga todas as imagens, de forma assíncrona (< 6 s) | Reproduzido duas vezes, depois de um controle de estabilidade de 22 min sem nenhuma escrita (as imagens não somem sozinhas) |
| `PATCH /produtos/{id}` sem `midia` preserva as imagens | Inclusive com o corpo completo de `corpoProdutoBling`: o preço mudou de 1 para 2 e as imagens ficaram |
| `imagensURL` não vazio (PATCH ou PUT) **acrescenta**, com deduplicação | O mesmo objeto com outro token de URL assinada não duplica |
| `imagensURL: []` apaga todas | — |
| Não há remoção seletiva, nem campo de ordem ou de principal | A ordem é a de inserção; imagem nova vai para o fim. Com uma imagem só, ela é a principal |
| O Bling **copia** o arquivo para `orgbling.s3.amazonaws.com`, de forma assíncrona | MD5 idêntico ao original. Depois da importação, apagar a origem não afeta o Bling (a origem passou a responder 400 e o Bling continuou servindo a cópia) |
| Leitura: `midia.imagens.{externas, internas[{link, linkMiniatura, validade}], imagensURL}` | Sem `ordem` nem `anexo`. A chave interna muda a cada importação e não é hash do conteúdo, então não identifica a foto |
| `DELETE` de produto ativo → 400, código 12 "Produto deve estar com situação excluído" | `PATCH /produtos/{id}/situacoes {situacao:'E'}` → 204, depois `DELETE` → 204 e `GET` → 404 |
| Limite de 3 MB por imagem | Central de ajuda do Bling. O bucket do ORBITA passou de 5 MB para 3 MB |

Consequências no código:

- `BlingClient.atualizarProduto` usa `PATCH`, nunca leva `midia`, e a
  regressão é testada (`src/services/bling-produto-midia.test.ts`). Antes,
  cada edição de nome ou preço apagava as imagens do produto no Bling.
- A mídia tem operações próprias na porta (`limparImagensDoProduto`,
  `importarImagemDoProduto`, `consultarProduto`), e nunca passa por
  `atualizarProduto`.
- A exclusão de produto segue situação `E` → `DELETE` → `GET` 404. Veja
  "Exclusão de produto" abaixo.

## Estratégia de URL

O Bling importa por URL. O servidor assina o objeto atual do bucket privado com
validade de 15 minutos (`VALIDADE_DA_IMPORTACAO_NO_BLING_S`) e entrega a URL
somente ao Bling. A URL nunca vai para o banco, para o log, para a auditoria
nem para a resposta da rota. Como o Bling copia o arquivo, a expiração da URL
não afeta a imagem depois de importada.

## Modelo: autoridade, desejado, confirmado e drift

| Coluna (migration) | Significado |
|---|---|
| `imagem_bling_gerenciada_pelo_orbita` (72) | **Autoridade**: `true` desde o primeiro upload confirmado. Nunca volta a `false` |
| `imagem_storage_path` (70) | **Desejado**: a foto escolhida no ORBITA, ou `null` (nenhuma imagem) |
| `imagem_bling_sync_path` (72) | **Confirmado**: a foto que o Bling sabidamente reflete. Na remoção de uma foto ainda não confirmada, é a foto que o Bling pode estar exibindo (remoção pendente) |
| `imagem_bling_divergencia_detectada_em` (72) | **Drift**: quando uma leitura atual do Bling mostrou imagem num produto gerenciado e sem foto |

### Por que a autoridade não é redundante

Depois de uma remoção confirmada, desejado e confirmado voltam a `null`.
Isso é idêntico a "o ORBITA nunca adotou a imagem", mas o significado é
oposto:

- **nunca adotou:** o Bling é dono, e a imagem dele aparece como fallback;
- **adotou e removeu:** o ORBITA decidiu por nenhuma imagem, e o espelho do
  Bling nunca volta.

A dupla desejado/confirmado não guarda quem é a autoridade. Daí o boolean,
que é outra dimensão.

### Adoção

- A adoção acontece no compare-and-set que aponta `imagem_storage_path` para
  uma foto (`trocarCaminho` com `novo` não nulo): `imagem_bling_gerenciada_pelo_orbita
  = true` vai na mesma instrução. CAS perdido não adota.
- Trocar mantém `true`. Remover não toca no campo, nem a confirmação, nem
  uma falha no Bling. Excluir o produto apaga a linha.
- Nesta entrega não existe ação para devolver a imagem ao Bling.
- A sincronização Bling → ORBITA e o webhook nunca escrevem o campo, nem de
  `false` para `true` nem de volta: `ProdutoRepository.upsert` o remove do
  payload.
- A migration faz backfill: linha com foto ou confirmação já é gerenciada.

### Drift no estado "nenhuma imagem"

Com o produto gerenciado e nada desejado, uma leitura **atual** do Bling pode
mostrar uma imagem: alguém pôs no Bling, ou um efeito antigo chegou depois. O
par desejado/confirmado não representa "nenhuma imagem desejada, remoto
divergente": o confirmado é um caminho do bucket, não uma imagem qualquer do
Bling. Por isso a migration 72 guarda o menor estado extra, o instante da
detecção.

- **Registro:** `registrar_divergencia_da_foto_no_bling` é um UPDATE
  condicional. Só vale para produto gerenciado, sem foto, sem drift já
  registrado e sem lease vigente, porque uma sincronização em curso passa por
  estados intermediários.
- **Leitura atual:** só a listagem e o detalhe lidos agora contam. O payload
  de um webhook pode descrever um momento superado e não registra drift.
- **Efeito:** o estado vira `pendente`, com "Tentar sincronizar novamente".
  A convergência limpa o Bling, e o compare-and-set da confirmação apaga o
  drift. A imagem nunca aparece como fallback.

### Estados (`estadoDaFotoNoBling`)

| Autoridade | Desejado | Confirmado | Drift | Estado |
|---|---|---|---|---|
| `false` | `null` | `null` | — | `sem_foto`: o Bling é dono |
| `true` | A | A | não | `sincronizada` |
| `true` | `null` | `null` | não | `sincronizada`: **nenhuma imagem**, nunca `sem_foto` |
| `true` | `null` | A | — | `pendente` (remoção) |
| `true` | B | A ou `null` | — | `pendente` |
| `true` | qualquer | igual ao desejado | sim | `pendente` |
| `true`, sem `bling_id` | qualquer | qualquer | — | `sem_vinculo`: nunca se busca por nome ou SKU |

`sincronizando` existe só na tela, enquanto a requisição está em curso.
`em_andamento` existe só na resposta: outra execução detém o lease do produto
e esta não tocou no Bling. A tela mantém a foto e oferece a nova tentativa.

A migration 72 prende `imagem_bling_sync_path` ao prefixo da própria linha, com
a mesma regra de `imagem_storage_path`, e recusa URL. A sincronização
Bling → ORBITA e o webhook nunca escrevem a foto, a confirmação, a autoridade
nem o lease. `produtoRepository.upsert` remove esses campos do payload. Guardas
de código-fonte também garantem que eles não chamam a sincronização da foto
nem montam `imagensURL`, então não há laço.

## Precedência visual (`comImagemEfetiva`)

1. Com `imagem_storage_path`, a tela mostra a foto do ORBITA, por URL assinada.
2. Sem foto e **gerenciada**: placeholder. O espelho `imagem_url` nunca é
   usado, nem na remoção pendente, nem depois da remoção confirmada, nem com
   drift, nem quando um webhook ou uma sincronização atrasada regrava
   `imagem_url`. Se a assinatura da foto falhar, também placeholder.
3. Só quando o ORBITA nunca adotou a imagem, a imagem do Bling (`imagem_url`)
   aparece como fallback.
4. As rotas de confirmar e remover respondem pela mesma regra: placeholder,
   nunca o espelho.
5. Quando a remoção é confirmada (zero imagens lidas no Bling), o mesmo
   compare-and-set esvazia `imagem_url`.

## Algoritmo (`sincronizarFotoComBling`)

Roda depois do compare-and-set local em confirmar, trocar e remover, e no botão
"Tentar sincronizar novamente", que não exige novo upload porque o objeto já
está no bucket.

1. Relê o produto no banco, escopado pela organização verificada, adquire o
   lease do produto (sem ele, `em_andamento`) e relê de novo sob o lease.
2. `sem_foto` → nada a fazer. `sincronizada` → sucesso idempotente, sem
   nenhuma chamada ao Bling. Sem `bling_id` → `sem_vinculo` (evento `pending`).
3. `PATCH imagensURL: []`, depois leitura até zero imagens.
4. Desejado nulo (remoção) → pula para o passo 7.
5. URL assinada temporária do desejado, depois `PATCH imagensURL: [url]`.
6. Leitura até **exatamente uma** imagem.
7. Compare-and-set: `imagem_bling_sync_path = desejado WHERE
   imagem_storage_path = desejado` (ou `IS NULL` na remoção) `AND
   imagem_bling_sync_lease_token = token`, escopado por id e organização.
   Depois, o lease é liberado em `finally`.

Cada espera cabe num orçamento total de 40 s, com leitura a cada 2 s; as rotas
têm `maxDuration = 60`. Limite (429) e erro indeterminado durante a leitura são
tratados como transitórios; recusa e produto ausente encerram.

## Falha, retry e idempotência

- Falha do Bling nunca derruba a foto local. A rota responde 200 com
  `bling: 'pendente'`, e a tela mostra "Foto salva no ORBITA. Sincronização com
  o Bling pendente." Com sucesso, a mensagem é "Foto atualizada."
- Falha entre limpar e importar deixa o Bling sem imagens e o estado
  `pendente`. Nada é desfeito localmente, porque não há transação comum entre
  banco e Bling.
- O retry repete a convergência inteira. Limpar e importar sempre levam ao
  mesmo estado observável, então repetir não duplica: o resultado é uma A,
  nunca duas.
- A quantidade é a prova: uma importação aceita que não aparece na releitura,
  ou um resultado com mais de uma imagem, não é marcado.
- Uma exceção inesperada na sincronização vira `pendente` na resposta e
  `registrarFalhaInterna` no log, sem corpo remoto.

## Concorrência

O compare-and-set final é condicionado ao desejado que **iniciou** a execução.
Uma sincronização de A que termina depois de o usuário trocar para B, ou
remover, não marca nada (`Obsoleta`). A execução seguinte converge para o
desejado atual. Testes cobrem A→B, A→remover, troca durante a espera do vazio e
dois retries concorrentes.

Remover uma foto que o Bling ainda não confirmou grava, na mesma instrução do
compare-and-set local, `imagem_bling_sync_path = foto removida`. Isso vale só
para produto vinculado. A remoção fica `pendente` e a sincronização limpa o
Bling. Sem isso, uma importação ainda em curso, ou que estourou o prazo,
deixaria no Bling uma foto que o usuário removeu, com a tela dizendo `sem_foto`.

### Lease por produto: uma execução escreve no Bling por vez

O compare-and-set impede uma execução velha de **marcar** outra foto, mas não
de continuar **escrevendo** no Bling. Sem uma trava, a corrida seria esta:

1. A começa;
2. o desejado muda para B;
3. B começa, limpa, importa B e confirma B;
4. A, atrasada, importa A;
5. o compare-and-set de A falha;
6. o banco diz "B sincronizada" e o Bling termina com `[B, A]`.

Por isso toda escrita no Bling acontece sob o lease do produto (migration 72):
`imagem_bling_sync_lease_token uuid` e `imagem_bling_sync_lease_expires_at
timestamptz`, ambos nulos ou ambos preenchidos.

- **Aquisição** é atômica: `adquirir_lease_da_foto_no_bling` é **um**
  `UPDATE ... WHERE id AND organizacao_id AND (token IS NULL OR expires_at <=
  now())`, com o relógio do Postgres. Não há SELECT prévio. Duas aquisições
  simultâneas se serializam na trava da linha, e a segunda reavalia a
  condição e não adquire. Isso está provado com duas transações reais em
  `scripts/database-concurrency-foto-produto.mjs`.
- **Fluxo:**
  1. detecta se há trabalho;
  2. adquire o lease; sem ele devolve `EmAndamento`, sem tocar no Bling;
  3. **relê** o produto e converge para o desejado atual;
  4. confirma por compare-and-set, que também exige o próprio token;
  5. libera em `finally`.
- **Liberação**: `liberar_lease_da_foto_no_bling` só zera o lease quando o
  token é o desta execução. Nunca libera o de outra. Se a liberação falhar,
  o lease expira sozinho.
- **TTL de 90 s** (`VALIDADE_DO_LEASE_DA_SINCRONIZACAO_S`): excede o
  orçamento da convergência (40 s) e o `maxDuration` da rota (60 s). Um
  lease só vence depois que a execução que o tinha já não pode tocar no Bling.
  Lease vencido pode ser recuperado. Uma execução que perdeu o lease não
  confirma.
- As duas funções são `security invoker`, com `execute` só para
  `service_role`. O token nunca sai em resposta, log ou auditoria.

Com o lease, a mesma corrida termina assim: B concorrente devolve
`em_andamento` sem tocar no Bling; A termina `Obsoleta` e libera; a nova
tentativa de B adquire e o Bling termina exatamente com `[B]`.

## Espelho `imagem_url`: tri-estado

`imagem_url` é o espelho da imagem do Bling. A sincronização e o webhook o
gravam em três estados, que não se confundem (`src/services/imagemDoBling.ts`):

| Estado | Quando | Gravação |
|---|---|---|
| Imagem confirmada | O Bling mostrou uma imagem | a URL atual |
| Ausência confirmada | Leitura **completa** (bloco `midia.imagens` com `internas` e `externas`, como o `GET /produtos/{id}`) sem imagem | `null` explícito |
| Desconhecida | O payload não traz a mídia e a leitura complementar falhou | o valor local anterior |

- **Webhook:** se o payload não tem o bloco de mídia, busca o detalhe. Se o
  detalhe veio completo e sem imagem, grava `null`. Se a busca falhou, mantém
  o valor local.
- **Sincronização de catálogo:** a listagem `GET /produtos` confirma imagem
  presente, mas não prova ausência. Sem imagem na listagem, ela faz **uma**
  leitura de detalhe, e só quando o espelho local tem imagem a perder (o
  espelho local da página é lido numa consulta só). Não há GET extra para
  cada produto.
- Nenhum dos dois escreve `imagem_storage_path`, `imagem_bling_sync_path`
  ou o lease.

Origem: o produto "Kuripe Cobra" estava sem imagem no Bling e com imagem no
espelho. A ausência nunca era gravada. O dado real não foi alterado: a
próxima sincronização o corrige pelo caminho normal.

## Auditoria (migration 72)

| Evento | Severidade | Quando |
|---|---|---|
| `catalog.product_image_bling_sync_pending` | info | Produto sem vínculo com o Bling |
| `catalog.product_image_bling_synced` | info | Convergiu e o compare-and-set valeu |
| `catalog.product_image_bling_sync_failed` | warning | Falhou em uma etapa (`limpar`, `confirmar_vazio`, `assinar`, `importar`, `confirmar_importacao`) |

Metadata permitida: `produto_id`, `operacao` (`adicionar`/`trocar`/`remover`),
`havia_sincronizacao_anterior`, `motivo`, `etapa` e `resultado`. URL, token,
caminho do objeto, corpo e resposta do Bling são proibidos pelo catálogo.
Falha ao auditar não interrompe a sincronização.

## Exclusão de produto

`POST /api/produtos/delete` recebe só o id local. O `bling_id` vem do banco,
nunca do navegador.

1. Produto com `bling_id`: `PATCH situacoes E`, depois `DELETE`, depois
   `GET` 404 (`excluirProdutoNoBling`, que reaproveita
   `exclusaoRemotaConfirmada`). Uma resposta ambígua é decidida pelo `GET`, e
   nunca há um segundo `DELETE` às cegas.
2. Sem ausência confirmada no Bling, nada local é apagado. Recusa → 409, limite
   → 503, produto ainda presente → 409, indeterminado → 503. O corpo bruto do
   Bling não aparece na resposta.
3. Só então a linha local sai, e depois o objeto no Storage
   (`excluirProdutoComFoto`).
4. Produto sem `bling_id`: só a exclusão local.

## Validação real (2026-10-02, uma execução)

A validação usou os métodos reais do `BlingClient` e a lógica real de
`sincronizarFotoComBling` e `excluirProdutoNoBling`. A linha do banco foi
simulada em memória, porque a migration 72 não está aplicada. O produto
descartável foi `ORBITA_SANDBOX_VALIDACAO_FOTO_NAO_USAR`, e as imagens de
origem ficaram num bucket temporário, apagado no fim.

| Passo | Resultado no Bling (MD5 de cada imagem conferido) |
|---|---|
| Adicionar A | `Sincronizada` em 9 s; exatamente A |
| Trocar para B | `Sincronizada` em 11 s; só B |
| Remover | `Sincronizada` em 5 s; zero imagens; confirmado voltou a `null` |
| Readicionar A, editar nome e preço por `atualizarProduto` (PATCH), reler 20 s depois | Nome e preço alterados; A continua lá, sozinha |
| Excluir | `AusenciaConfirmada` (situação `E` → `DELETE`), `GET` 404 |

Observações:

- A listagem do Bling assina de novo `imagemURL` a cada leitura, mesmo sem
  nenhuma escrita. Um retrato que inclua a assinatura nunca bate; compare só o
  caminho do objeto.
- Os webhooks do Bling fazem o ORBITA publicado espelhar produtos criados no
  Bling. Os produtos descartáveis ganharam linhas locais no projeto de
  desenvolvimento. Essas linhas continuam lá mesmo depois do 404 no Bling: a
  exclusão no Bling não remove o espelho local.

## O que não foi feito nesta entrega

- As migrations 70, 71 e 72 não foram aplicadas em nenhum ambiente remoto.
- O bucket definitivo `produto-imagens` não foi criado.
- A validação real foi uma única execução controlada na conta Bling autorizada
  como sandbox, com produto descartável, removido no fim.
