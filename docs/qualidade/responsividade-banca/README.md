# Responsividade para a banca — 22/11/2026

Base: main `6603ff9` (merge #158). Branch: `codex/responsividade-banca`.
Nenhuma alteração em componentes da Mensageria, serviços, regras comerciais,
workers, banco ou configuração dos canais. Sem operações comerciais no staging.

## Problemas reproduzidos e correções

| Problema | Causa | Correção |
|---|---|---|
| Financeiro 390 px: gráficos sobre a tabela | A grade conservava uma coluna mínima de 424 px, deixando a coluna dos gráficos sem largura; filhos flexíveis conservavam altura de desktop | Uma coluna até 1100 px; gráficos com 240 px e duas colunas no tablet, uma no celular; tabela com rolagem própria |
| Barra superior e filtros cortados | Linha flex sem quebra, mínimos de conteúdo e área principal sem rolagem | Quebra de linha e mínimos compatíveis com o espaço disponível; rolagem vertical do ERP |
| Visão Geral estreita | Coluna do anel fixa, legenda e rodapé da série sem quebra | Empilhamento, legenda em uma/duas colunas e rodapé flexível |
| Organização e Integrações estreitas | Grades de três/duas colunas mantidas no tablet/celular | Uma coluna e altura natural; listas com rolagem própria |
| Integrações com dados reais excedia 390 px | Bloco da última verificação não cedia largura e linhas de eventos não quebravam | Limitar o bloco ao cartão e permitir quebra das linhas somente dentro da página de Integrações |
| Textos coloridos ilegíveis no tema claro | Cores de destaque próprias de fundos escuros usadas como texto | Variantes escuras de texto, limitadas às páginas do ERP e aos modais; acentos dos gráficos e pontos mantidos |
| Campos legados dos modais com contraste insuficiente | Classes de texto branco/cinza e fundos escuros sem adaptação ao tema | Texto, campos e lista de opções com cores do tema dentro do modal, sem modificar formulários ou persistência |
| Gráficos medidos com dimensão zero ao navegar | Financeiro permanecia montado e oculto | Montar apenas os gráficos quando a aba está ativa; manter filtros, hooks e formulários |
| Navegação abria outra tela já rolada | A área de rolagem é compartilhada pelas abas | Retornar ao topo ao mudar de aba do ERP, preservando os nós e os valores; sem comandar a rolagem do SAC |

Não foram adicionados `overflow: hidden` ou `clip` para esconder os defeitos.
As tabelas mantêm largura legível e rolagem horizontal interna; o teste alcança
o botão Detalhes sem criar rolagem horizontal na página.

## Matriz visual

As seis telas (Visão Geral, Vendas, Estoque, Financeiro, Integrações e Organização)
foram capturadas em Chromium real nas 36 combinações de 390×844, 768×1024 e
1366×768 com temas claro e escuro. A inspeção das capturas inclui o início e o
alcance do conteúdo após rolagem. Dados determinísticos sintéticos alimentam
os componentes reais, dentro da moldura e do rail reais. Isso comprova layout,
não integração de serviços.

Os 49 casos de `test:responsividade` passaram: 36 combinações, 12 combinações
mobile com os tokens do #157 e navegação com retorno ao topo. As verificações
cobrem largura, posição da barra superior, separação entre gráficos e tabela,
altura dos gráficos, alcance horizontal da tabela e ausência de escritas.
Uma amostra de valor financeiro no tema claro exige contraste de pelo menos
4,5:1 contra pixel do fundo capturado; não equivale a uma auditoria WCAG completa.

Compatibilidade: #157 `1b5b332` ainda aberto na inspeção. Seus tokens mobile
foram exercitados somente no fixture; não foram copiados para o produto.

## Modais e HelpInfo

21 casos visuais cobrem despesas e diálogos relacionados, produto, cliente,
venda manual, cabeçalhos e as 66 ajudas. Produto/cliente/venda são verificados
nas três larguras e nos dois temas: campo final alcançável, rodapé separado,
ajuda no cabeçalho, Escape e restauração de foco, rascunho preservado.
Na execução local inicial, 14 passaram; os sete restantes passaram após corrigir
a asserção que incluía o checkbox do rodapé como campo do corpo e repetir um
timeout de 1920 px. Os seis casos de produto/cliente/venda passaram novamente
após a correção dos fundos dos campos legados, com uma asserção específica
para impedir texto escuro sobre campo escuro no tema claro.
A CI executa os 21 juntos no HEAD do PR.

## Inspeção não destrutiva do staging

As seis telas carregaram com a sessão existente, incluindo leituras de dados.
Não foram acionados sincronização, salvar, criar, excluir ou operações de estoque.
Os cinco GETs sem sessão para `/api/dashboard`, `/api/financeiro`,
`/api/organizacoes`, `/api/integracoes/saude` e `/api/produtos` retornaram
401 JSON, confirmando disponibilidade e proteção de acesso, sem provar HTTP 200
autenticado. No console observado havia avisos Recharts de dimensão zero;
o teste da branch também vigia esses avisos. Nenhum erro fatal foi observado.

Após o login do usuário, a prévia local autenticada foi conferida nas seis telas
e três resoluções, no tema escuro servido pelo aplicativo: 18 combinações com
dados reais, sem acionar operações. A inspeção revelou e permitiu corrigir o
estouro de largura da última verificação e dos estados de eventos em Integrações.
Os fixtures agora incluem conexões verificadas e evento recebido para cobrir
esse caso. [Métricas autenticadas sem dados pessoais](inspecao-autenticada.json):
nenhuma largura principal ou barra superior excedeu o espaço disponível.
O console observado após a navegação não continha erros nem avisos.
O tema claro continua coberto pelos componentes reais com dados sintéticos;
o aplicativo não oferece um seletor de tema nessa sessão.
Não há evidência de pós-publicação desta branch: o PR não foi mesclado.

## Evidências

- A captura original de antes foi retirada por conter dados comerciais reais; a reprodução e a causa estão descritas acima.
- [Depois: barra e resumo, 390 px](capturas/final-finance-390-dark.png).
- [Depois: gráficos empilhados, 390 px, após rolagem](capturas/final-finance-390-dark-graficos.png).
- [Depois: Financeiro desktop, 1366 px](capturas/final-finance-1366-dark.png).
- [Evidência visual anonimizada: componentes reais com dados sintéticos](capturas/final-finance-390-dark-graficos.png). A inspeção autenticada está registrada somente pelas métricas sem dados pessoais.
- Modais 390 px, tema claro: [produto](capturas/modal-390-claro-produto.png), [cliente](capturas/modal-390-claro-contato.png), [venda](capturas/modal-390-claro-pedido.png).

Todas as capturas mantidas no pacote usam dados sintéticos; os valores diferem do staging.
As duas imagens originadas do staging foram removidas também do histórico ativo
da branch do PR antes do merge. Isso não comprova eliminação de objetos antigos,
referências internas de revisão ou caches retidos pelo GitHub.
O artefato `helpinfo-visual` da CI contém relatórios e capturas de toda a matriz.
Reprodução: `npm run test:helpinfo:visual` e `npm run test:responsividade`.
