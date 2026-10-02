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

## Modelo: desejado × confirmado

| Coluna | Significado |
|---|---|
| `imagem_storage_path` (migration 70) | **Desejado**: a foto escolhida no ORBITA, ou `null` |
| `imagem_bling_sync_path` (migration 72) | **Confirmado**: a foto que o Bling sabidamente reflete. Na remoção de uma foto ainda não confirmada, é a foto que o Bling pode estar exibindo (remoção pendente) |

Estado da tela (`estadoDaFotoNoBling`), sem booleanos persistidos:

- `sem_foto`: os dois são nulos. O ORBITA nunca adotou as imagens, ou a
  remoção foi confirmada.
- `sincronizada`: desejado = confirmado.
- `pendente`: os dois diferem e o produto tem `bling_id` numérico.
- `sem_vinculo`: os dois diferem e o produto não tem `bling_id`. Nunca se busca
  o produto por nome ou SKU.

`sincronizando` existe só na tela, enquanto a requisição está em curso.

A migration 72 prende `imagem_bling_sync_path` ao prefixo da própria linha, com
a mesma regra de `imagem_storage_path`, e recusa URL. A sincronização
Bling → ORBITA e o webhook nunca escrevem nenhuma das duas colunas:
`produtoRepository.upsert` remove ambas do payload. Uma guarda de código-fonte
também garante que eles não chamam a sincronização da foto nem montam
`imagensURL`, então não há laço.

## Algoritmo (`sincronizarFotoComBling`)

Roda depois do compare-and-set local em confirmar, trocar e remover, e no botão
"Tentar sincronizar novamente", que não exige novo upload porque o objeto já
está no bucket.

1. Relê o produto no banco, escopado pela organização verificada.
2. `sem_foto` → nada a fazer. `sincronizada` → sucesso idempotente, sem
   nenhuma chamada ao Bling. Sem `bling_id` → `sem_vinculo` (evento `pending`).
3. `PATCH imagensURL: []`, depois leitura até zero imagens.
4. Desejado nulo (remoção) → pula para o passo 7.
5. URL assinada temporária do desejado, depois `PATCH imagensURL: [url]`.
6. Leitura até **exatamente uma** imagem.
7. Compare-and-set: `imagem_bling_sync_path = desejado WHERE
   imagem_storage_path = desejado` (ou `IS NULL` na remoção), escopado por id
   e organização.

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

**Risco residual, aceito e registrado.** Não há trava por produto entre
instâncias. Considere duas execuções simultâneas com desejados diferentes, por
exemplo duas abas trocando quase ao mesmo tempo. Se a importação de uma for
processada pelo Bling exatamente entre a releitura de "uma imagem" da outra e o
processamento da própria importação, a outra pode marcar `sincronizada`
enquanto o Bling termina com duas imagens. A releitura conta imagens e não
identifica a foto, porque o Bling não expõe identidade estável. A tela de uma
aba fica bloqueada em "sincronizando" durante a execução, o que reduz a janela.
A correção é uma nova troca, ou remover e enviar de novo. Se isso se mostrar
real em produção, o próximo passo é um lease por produto no banco.

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
