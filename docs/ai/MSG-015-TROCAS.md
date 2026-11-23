# MSG-015 — Prévia de troca ou devolução

O cockpit prepara uma prévia de conferência em um caso SAC aberto. A API usa a organização e o ator da sessão verificada, confirma a ligação do pedido com o cliente da conversa e suprime os dados do pedido na ausência de prova ou de sincronização atual. Os campos de intake são validados por Zod. A pergunta sugerida é determinística e trata uma pendência por vez. Valores comprovados são apresentados em centavos de BRL, com a fonte e a data da sincronização. O rastreio permanece sem fonte.

A prévia é transitória. A versão 1 identifica o contrato da resposta. O editor persistente é separado da prévia e está descrito em [Persistência MSG-015](MSG-015-PERSISTENCIA.md). A API registra o resultado da consulta com correlação, ator, organização e conversa. O texto digitado, dados pessoais e o conteúdo da conversa ficam fora do log. Os únicos ports da rota são leituras do caso e do pedido.

## Inventário da base 34d103f

| Ticket | Fonte reaproveitável | Cobertura |
| --- | --- | --- |
| MSG-009 | `useControle`, `BarraDoAtendimento`, ordem 91 | Assumir e devolver com controle humano existente |
| MSG-010 | `clienteVerificado`, `/api/sac/verificacao`, ordem 92 | Prova do cliente vinculada à organização e à conversa |
| MSG-011 | `retratoDoPedido`, `/api/sac/pedidos/retrato`, ordem 93 | Espelho de leitura do pedido, pagamento e estoque. Rastreio sem fonte |
| MSG-012 | [Ranking isolado #167](https://github.com/SenhorMk/ORBITA/pull/167) | Até três alternativas com filtros, explicação e delta em centavos. Falta fonte de compatibilidade versionada para o catálogo real |
| MSG-013 | Catálogo e RPC `registrar_evento_auditoria` | Infraestrutura existente. Aprovações de troca ainda precisam de eventos próprios |
| MSG-014 | `respostaAutomaticaHaux`, `scripts/worker-haux-bot.ts` | Geração e triagem existentes. Intake automático pelo worker fora desta prévia |
| MSG-022 | Rota de autorresposta e política por inbox | Controle e desligamento existentes, sem mudanças |

O ledger da base termina na ordem 104. A ordem 105 está proposta no #165, em outra branch. Esta prévia tem zero migrations. Referências de escopo, gates e critérios de aceite. [MSG-015](https://docs.google.com/document/d/1EL_BdtFNAVcn8HW6a0lmJkg3cqQpxuY_/edit) · [MSG-012](https://docs.google.com/document/d/1RZ0f8YWcelIz9j84wRd6gilNyN8HnRpp/edit) · [Arquitetura](https://docs.google.com/document/d/1X1_PcTsRU4EwiXtZcQ27QGPjbwFOV9CI/edit) · [Índice](https://docs.google.com/document/d/1JuYcZZunqXnSaPhX5ZQiz44pc05EaCNy/edit)

## Integração da jornada persistente

A proposta persistente usa o ranking do #167 e uma fonte autorizada por organização. Política D7 e compatibilidade ausentes impedem aprovação, com pendências distintas. O editor preserva versões anteriores e exige decisão explícita sobre a versão atual. O laboratório aplica as ordens 105 e 106 pelo ledger canônico. O ensaio transacional e o smoke de decisão no navegador verificam a composição.

## Bling API v3 e interface

A matriz cruza a OpenAPI oficial referenciada pelo portal, o snapshot do repositório `docs/integrations/bling-v3-paths.json` e as páginas de ajuda. A presença do método confirma a superfície publicada. Autorização, semântica de estado, operações reversas e idempotência exigem evidência própria. [Referência Bling](https://developer.bling.com.br/referencia) · [OpenAPI consultada](https://developer.bling.com.br/build/assets/openapi-6Fd4UNsA.json)

| Área | API confirmada | Interface Bling / capacidade ainda sem evidência na API |
| --- | --- | --- |
| Pedidos de venda | `GET/POST /pedidos/vendas`, `GET/PUT/PATCH/DELETE /pedidos/vendas/{idPedidoVenda}` | Cancelamento universal para trocas e criação idempotente sem reconciliação |
| Situações | `GET /situacoes/modulos`, `GET /situacoes/modulos/{idModuloSistema}`, `PATCH /pedidos/vendas/{idPedidoVenda}/situacoes/{idSituacao}` | Transições permitidas e efeitos fiscais dependem da configuração e de validação do caso |
| Estoque | `GET /estoques/saldos`, `GET /estoques/saldos/{idDeposito}`, `POST /estoques`, `PUT /estoques/{idEstoque}` | Reserva da ordem de troca deve ser atômica no ORBITA |
| Logística | `GET /logisticas`, `POST /logisticas/objetos`, `GET /logisticas/objetos/{idObjeto}`, `GET /logisticas/etiquetas` | Emissão de logística reversa documentada na interface |
| Remessas e rastreio | `POST /logisticas/remessas`, `GET /logisticas/remessas/{idRemessa}`, `GET /logisticas/{idLogistica}/remessas`; schemas de rastreamento de objetos e remessas | Consulta de reversões documentada na interface. Endpoint dedicado de rastreio reverso sem evidência |
| Frete | Cotação dedicada sem evidência na OpenAPI consultada | Cotação de Bling Envios documentada na interface |

[Logística reversa](https://ajuda.bling.com.br/hc/pt-br/articles/14122012038551-Log%C3%ADstica-reversa-dos-Correios) · [Consulta de reversões](https://ajuda.bling.com.br/hc/pt-br/articles/15774535614999-Como-consultar-a-situa%C3%A7%C3%A3o-e-rastreamento-de-revers%C3%B5es-log%C3%ADsticas) · [Cotação no painel](https://ajuda.bling.com.br/hc/pt-br/articles/4410325203095-Cota%C3%A7%C3%A3o-de-frete-da-log%C3%ADstica-Bling-Envios).

## Fase futura de execução

1. **EXE-001.** Comando separado revalida ator, aprovação vigente, versão/digest, produto, elegibilidade, D7 e delta. Cria uma ordem local idempotente de troca. Preserva o pedido original e seus vínculos fiscais e financeiros. Cancelamento só pode ser uma decisão expressa e própria do caso.
2. **EXE-002.** Criar intenção do substituto bloqueada e reserva atômica por produto, organização, depósito e quantidade. Auditar transições e prever liberação de reserva.
3. **EXE-003.** Usar PSP autorizado para diferença positiva confirmada, com chave idempotente e comprovante. Diferença negativa segue EXE-011/D10 ou atendimento humano conforme política. Nunca interpretar timeout como sucesso ou falha definitiva.
4. **EXE-004.** Liberar somente com saldo, política, versão, pagamento e gates logísticos confirmados. Na publicação Bling posterior, registrar intenção estável e recibo, procurar o pedido antes de repetir criação e conciliar NF, estoque, cobrança e ordem de embalagem. Tratar resultado desconhecido como `UNKNOWN`, retentar só quando seguro e encaminhar estados não conciliados ao humano.
5. **Logística reversa.** Guardar IDs separados de entrega original, devolução e expedição substitutiva. Registrar duas cotações verificadas, transportador e responsável pelo custo conforme D7 e direito aplicável. Exigir entrega do objeto reverso correto e conferência física, ou exceção expressamente aprovada para envio antecipado. Antes de efeitos comerciais, satisfazer PRE-003, PRE-006D, PRE-007A, PRE-007B e D7. [EXE-001](https://docs.google.com/document/d/1IaJsJQjBeLKupPCh5kab1V8amE7J-ZOR/edit) · [Decreto 7.962/2013](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm)
