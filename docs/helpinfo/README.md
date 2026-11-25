# HelpInfo — integração do D07 existente

O pacote `ORBITA-D07-HelpInfo-65.zip` foi recuperado e seu SHA256 conferido. A integração reaproveita o patch completo, componente Radix, catálogo, matriz e testes existentes; não reconstrói a entrega. Bases e checksums estão em `proveniencia.json`.

## Cobertura

`matriz.json` e `matriz.csv` mantêm as 65 superfícies originais e acrescentam a ajuda de movimentações de estoque do #153: 66 superfícies com conteúdo e montagem (64 depois que as listas técnicas "Mensagens recebidas" e "Envios com atenção" saíram da aba Integrações), além de uma exclusão formal do legado `TransactionList`. Essa contagem não equivale a todos os estados possíveis do produto. As localizações foram recalculadas sobre a main `2e0b98f`, com #152 e #153. A ajuda do controle de atendimento foi revisada para IA-first, takeover e devolução com resumo e mensagem nova. Foram esclarecidos o resumo financeiro e a impossibilidade de editar papéis pela lista de membros.

O #153 foi mesclado na main em `2e0b98f` e incorporado por merge normal à branch do HelpInfo. A 66ª ajuda agora é montada na seção existente “Movimentações de estoque” do detalhe do produto. A implementação ERP continua vindo da main, sem alterações neste PR de ajuda.

## Preservação

`preservacao.json` compara os 46 componentes existentes com a main pós-#153, por AST, retirando apenas import/JSX de HelpInfo, sua condição de montagem na seção de estoque e espaços JSX vazios. O restante permanece igual: campos, handlers, regras, compositor, limite dos painéis do cockpit e preferências. Não há alteração de API, banco, credenciais ou dependências no delta do HelpInfo.

O ícone tem aparência discreta, foco visível e alvo de 44px em dispositivos de toque. O diálogo cabe em telas pequenas e rola internamente. Botões são `type="button"`; a ajuda isola a ativação do mouse/teclado das ações do contêiner. Escape fecha apenas a ajuda e devolve o foco ao acionador. O conteúdo é estático, sem dados de clientes.

## Verificação

- `src/components/help/HelpInfo.test.tsx`: conteúdos, mouse, teclado, foco, formulário, diálogo aninhado e isolamento da ação do contêiner.
- `src/components/help/cobertura.test.ts`: correspondência entre matriz/catálogo e montagem real nas telas; a galeria não conta como montagem do produto.
- Testes dos componentes afetados e do cockpit verificam a preservação das interações existentes.
- O harness visual do pacote original é reutilizado sobre os componentes atuais, com portas explícitas de memória e rede restrita a loopback. Essa prova de interface não comprova API, Bling, cobrança ou banco.
- O CI completo e o preview da branch devem estar aprovados antes de qualquer merge.

As ressalvas do pacote original continuam relevantes: o rodapé comercial em 390px tinha aperto preexistente (`RODAPE-MOBILE-01`); as ajudas dos formulários ficam no corpo rolável. Não se declara responsividade integral de toda a aplicação ou certificação WCAG com base apenas nos diálogos de ajuda. O billing permanece oculto na navegação conforme a base, embora tenha ajuda no componente.

Este PR não altera a operação do bot. A ativação de novas conversas Haux foi autorizada e registrada separadamente. Não há merge automático deste HelpInfo.
