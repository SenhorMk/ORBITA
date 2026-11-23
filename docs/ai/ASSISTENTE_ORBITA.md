# Assistente ORBITA

Este documento especifica o comportamento, as capacidades, os limites e a governança do assistente de IA do ORBITA. Ele também registra o que já está implementado e o que ainda falta.

O assistente atua em dois contextos com autorização separada:

| Contexto | Quem usa | Canal | Acesso |
|---|---|---|---|
| **A. Atendimento ao cliente** | clientes da loja | Chatwoot (WebWidget e WhatsApp) | catálogo e políticas aprovadas, só leitura; nunca dados internos |
| **B. Assistente do comerciante** | membros da organização | painel do ORBITA | dados do ERP conforme o papel; escrita só com confirmação e auditoria |

> **Regra de ouro:** dado que não veio de uma fonte verificada não é afirmado. Quando a informação falta, o assistente diz isso com naturalidade e oferece a equipe. O cliente nunca fica sem resposta.

---

## 1. Inventário em 23/11/2026

### Já funciona
- Recepção WhatsApp → Evolution → Chatwoot → webhook assinado → `inbox_eventos_chatwoot` → caso SAC (`sac_cases`). O tempo do Chatwoot ao caso processado é de 0,5 a 5 s.
- Runtime AI-first por inbox (`chatwoot_ai_runtime`, migrations 100/101 do staging), com heartbeat, kill switch, fences de controle, cotas diárias e o worker do bot em container.
- Groq real (`openai/gpt-oss-20b`), com Gemini de alternativa. Smoke real em 22/11: a resposta levou de 757 a 873 ms e a triagem 1102 ms.
- Triagem estruturada (`sac.triagem`) com `precisaDeHumano` para reclamação, saúde, assunto jurídico, reembolso, pedido de pessoa ou confiança baixa.
- Takeover e handback pelo ORBITA, com versão de controle, nota privada e invalidação de envios em voo. Em 22/11 a conversa 11 foi assumida e devolvida pelo fluxo normal, e a projeção ficou `ok` em cerca de 5 s.
- Outbox com idempotência (`command_id`), fencing token e recibo do Chatwoot.
- **Assistente de atendimento ao cliente (contexto A), implementado neste PR e validado no WebWidget real em 23/11:**
  - respostas naturais geradas pelo Groq;
  - consultas somente leitura ao catálogo do ERP, às linhas da marca e às políticas (§10);
  - histórico recente da conversa;
  - validação de saída (§3).

### Ainda não conectado à IA (existe no ERP, sem ferramenta)
Nenhuma destas operações é acessível ao assistente hoje. O mapeamento está em §10.
- **Comandos de escrita:** produto e categorias (#114), clientes, pedido manual e situação de pedido no Bling (#115), cancelamento com estorno de estoque (#155).
- **Painéis de leitura:** vendas, estoque e movimentações, financeiro e cockpit.
- **Retrato verificado de pedido** (MSG-011), hoje usado só pelo atendente humano.

### Implementado, mas não ativado
- Inbox 2 (WhatsApp) liberada para conversas novas em 22/11, com autorização registrada. Conversas antigas continuam humanas por desenho: a IA só entra com prova de `conversation_created` recente ou após devolução.

### Limitado artificialmente (corrigido neste PR)
- `respostaAutomaticaHaux.ts` só deixava o modelo escolher abertura e pergunta de frases prontas.
- Uma regex enviava a humano qualquer menção a preço, produto, pedido ou frete, sem chamar o modelo.
- O prompt declarava que o único fato verificado era o nome da loja.

### Ausente
- Descrições por produto no ERP. As quatro linhas de defumador já têm a descrição da marca, do briefing de 12/10/2026, em `organizacoes/portalDoHaux.ts`.
- Políticas comerciais aprovadas do Portal do Haux (ver §6).
- Consulta de pedidos pelo cliente com identidade verificada.
- Assistente do comerciante (contexto B): projetado em §5 e §10, **sem código**. Nenhuma ferramenta administrativa está acessível à IA.
- Mensagem ao cliente no momento da escalada para humano (ver §8, L2).

### Depende de configuração
- Políticas e identidade de cada organização (`src/services/sac/assistente/conhecimento.ts`).
- Lista de produtos ocultos (demonstração e teste), também por organização.
- Limite diário de gerações por inbox (`chatwoot_ai_runtime.limite_geracoes_dia`): 20 nas inboxes 1 e 2.
- Limite diário de triagens do bot (`HAUX_BOT_LIMITE_TRIAGENS_DIA`): 50 desde 23/11. Com 20, os testes de 22–23/11 esgotaram a cota, e a conversa seguinte foi para humano sem resposta ao cliente.

### Depende de migration
- Escalada com mensagem ao cliente na mesma transação (L2).
- Ferramentas de escrita do assistente do comerciante, com trilha de auditoria própria (§5).

---

## 2. Identidade e comportamento (regras globais)

As regras abaixo valem para qualquer organização e ficam em `INSTRUCOES_GLOBAIS`, em `respostaAutomaticaHaux.ts`.

- **Transparência:** toda resposta automática começa com a identificação da organização (por exemplo "Assistente virtual do Portal do Haux"). O assistente não se passa por pessoa.
- **Linguagem:** português do Brasil, natural, educado e objetivo. Entende abreviações, gírias e erros de digitação.
- **Continuidade:** o modelo recebe duas seções, `<historico_contextual>` e `<solicitacao_atual>`, e responde só à atual. O histórico serve para entender referências ("e quanto custa?", "qual desses?"), nunca como fila de perguntas a responder de novo. Duas perguntas na mesma mensagem são respondidas juntas. O assistente não repete saudação numa conversa em andamento e responde em no máximo cinco frases curtas.
- **Solicitação atual:** são as mensagens do cliente posteriores à última resposta pública da conversa (IA ou atendente), encadeadas por intervalos de até 90 s. O corte é o mais recente entre a resposta no espelho (`chatwoot_messages`) e o envio público já registrado e não invalidado (`chatwoot_envios`), que aparece de 3 a 8 s antes do espelho. Só o instante é lido, com organização, conexão e conversa explícitas; nenhum texto de resposta vai ao modelo. Uma troca explícita de assunto na rajada ("na verdade", "mudando de assunto") deixa só o pedido novo. Se a leitura da última resposta falhar, só a última mensagem é pedido.
- **Ambiguidade:** quando falta informação, faz uma pergunta útil em vez de supor.
- **Personalização:** tom e identidade vêm da configuração da organização (§4), nunca do texto do cliente.
- **Memória:** o contexto é o histórico do caso SAC, mascarado (CPF, cartão, e-mail e telefone ocultados), mais o resumo do atendente quando houve devolução. Não há memória entre casos.

## 3. Arquitetura de conhecimento

O assistente **não** usa um prompt gigante. A cada mensagem, o worker monta só o necessário:

| Camada | Fonte | Onde | Vai ao modelo |
|---|---|---|---|
| 1. Instruções fundamentais | código versionado | `INSTRUCOES_GLOBAIS` | sempre |
| 2. Identidade da organização | configuração versionada | `assistente/conhecimento.ts` | sempre, poucas linhas |
| 3. Políticas aprovadas | configuração versionada, com situação e fonte | `conhecimento.ts` | só as `confirmada` viram fato; as demais vão como "NÃO INFORMADA" |
| 4. Dados dinâmicos do ERP | Supabase (`produtos` + `categorias`), espelho do Bling | ferramenta `consultar_catalogo` (`assistente/ferramentas.ts`, `catalogo.ts`, `leitorDeProdutos.ts`) | só os produtos relacionados à solicitação atual (até 12) e a lista de categorias |
| 5. Histórico da conversa | `sac_cases` e mensagens do caso | RPC `reivindicar_geracao_ai_first` | mascarado e limitado |
| 6. Ferramentas e permissões | escopo verificado do worker ou da sessão | runtime e papel | o cliente não tem ferramentas de escrita |

### Recuperação
- A recuperação é por termos, sem embeddings nem serviço externo.
- Os termos úteis da mensagem são normalizados: sem acento, minúsculos e com singular simples ("defumadores" vira "defumador").
- O assistente recebe os produtos cujo nome ou categoria compartilham termos com a **solicitação atual**. Catálogo, linhas da marca e políticas não são consultados pelo histórico.
- Se a solicitação só aponta para trás ("e quanto custa?", "qual você recomenda?", "tem disponível?"), entra apenas a mensagem anterior mais recente que tem assunto.
- Saudação não seleciona produto. Agradecimento ou despedida não consulta nada.
- O catálogo fica em cache de 60 s por organização.

### Validação de saída
Implementada em `assistente/validacao.ts`. Uma resposta que falha aqui não é enviada: devolve `null`, e a RPC `concluir_geracao_ai_first` escala para humano pelo caminho já auditado. A validação é feita frase a frase, e cada regra abaixo veio de um caso visto no smoke ou no widget real e tem teste em `validacao.test.ts`. A resposta é recusada se:
- citar preço (`R$ x,yy`) que não está no contexto daquela mensagem;
- trouxer link;
- pedir CPF, RG, senha, cartão ou código;
- afirmar ação executada ("já cancelei", "pedido foi enviado");
- tiver mais de 900 caracteres;
- citar preço longe do **nome real** do item do ERP com esse valor, ou renomear o item;
- atribuir preço ou estoque a um produto **sem cadastro** no ERP;
- prometer envio: pronta-entrega, envio imediato, prazo de entrega ou reserva. Estoque positivo **não** é prazo;
- apresentar como disponível um item **sem estoque**;
- atribuir benefício ou efeito que a marca não descreve (cura, alivia, garantido, terapêutico).

Em conversa em andamento, a saudação de abertura repetida é removida.

### Visão futura
- Os documentos Markdown por organização (`docs/ai/organizacoes/*.md`) podem virar fonte versionada das políticas, compiladas para o formato de `conhecimento.ts`.
- Busca semântica só quando o catálogo tiver descrições aprovadas e o volume justificar.

## 4. Conhecimento comercial por organização

O modelo de dados é `ConhecimentoDaOrganizacao`:

```ts
{
  organizacaoId,          // verificado no servidor, nunca vindo da mensagem
  nomeDaMarca,
  identificacao,          // primeira linha de toda resposta automática
  tom,
  politicas: [{ tema, situacao: 'confirmada' | 'pendente' | 'indisponivel', texto?, fonte? }],
  produtosOcultos: RegExp[]
}
```

- **Sem registro:** uma organização sem `ConhecimentoDaOrganizacao` não recebe fatos comerciais.
- **Isolamento:** preços e políticas de uma organização nunca são regras globais.

| Tema | Comportamento |
|---|---|
| Produtos e categorias | catálogo do ERP: nome, categoria, preço e disponibilidade (sem quantidade exata) |
| Descrições e diferenças | só se houver descrição aprovada. Hoje não há, e o assistente compara apenas por categoria, preço e disponibilidade |
| Preços e variantes | preço do ERP, citado exatamente |
| Promoções | só se houver política `confirmada` |
| Disponibilidade | "disponível" ou "sem estoque no momento" |
| Recomendações | baseadas no que a pessoa descreveu e no catálogo, sem atribuir propriedades |
| Pagamento, frete, prazos, trocas, cancelamento e reembolso | só políticas `confirmada`. Sem elas, o assistente orienta a falar com a equipe |
| Rastreamento | o assistente não consulta. Pede o número do pedido e a equipe confirma |
| Produtos que exigem cuidado (uso tradicional, saúde) | sem orientação de uso ou efeito; a equipe responde |

## 5. Assistente do comerciante (contexto B), projetado

- **Superfície:** rota autenticada do painel, com escopo verificado da sessão (`VerifiedOrganizationScope`) e papel do membro. Separada da inbox: um cliente nunca alcança essas ferramentas.
- **Ferramentas de leitura**, todas filtradas por `organizacao_id` do escopo:
  - `vendas_do_periodo(inicio, fim)`, sobre pedidos e itens;
  - `produtos_mais_vendidos(periodo, n)`;
  - `estoque_baixo(limite)`, sobre `produtos.estoque - estoque_reservado`;
  - `a_receber()`, sobre títulos financeiros;
  - `pedidos_atrasados()`;
  - `sugestao_de_reposicao()`, derivada de vendas e estoque.
- **Ferramentas de escrita:** propostas, nunca execução direta. O assistente monta um rascunho de operação, a pessoa confirma explicitamente e a execução passa pelo serviço existente, que registra auditoria (`ator_id` e evento). Exclusão em massa ("exclua todos os produtos") não tem ferramenta: o pedido é recusado e explicado.
- **Respostas:** valores sempre acompanhados do período e da fonte. Se o dado não existir, o assistente diz que não existe.
- **Permissões:** proprietário e administrador leem tudo da organização. Os demais papéis seguem as capacidades já existentes (`escopoTemCapacidade`).

## 6. Políticas do Portal do Haux: fonte e situação

Fontes consultadas em 23/11/2026:
- `PortaldoHaux/docs_desing/BRAND.md` (identidade visual de embalagem);
- `Portal_do_Haux_Briefing_Defumadores_Completo.pdf` (linha de defumadores em desenvolvimento);
- tema Shopify (`Site_liquid`);
- ERP (`produtos` e `categorias` no staging).

| Tema | Situação | Fonte |
|---|---|---|
| Nome e identidade da marca | **Confirmada** | ERP (organização) e BRAND.md |
| Catálogo, preços e disponibilidade | **Confirmada** (dinâmica) | ERP, espelho do Bling |
| Descrições e diferenças entre linhas de defumador | **Pendente de aprovação** | o briefing descreve uma família em criação, que não está no catálogo |
| Formas de pagamento | **Pendente de aprovação** | nenhuma fonte |
| Frete e entrega | **Pendente de aprovação** | nenhuma fonte |
| Prazo de preparação e postagem | **Pendente de aprovação** | nenhuma fonte |
| Trocas e devoluções | **Pendente de aprovação** | nenhuma fonte; as políticas do Shopify ficam no painel da loja, fora do repositório |
| Cancelamento e reembolso | **Pendente de aprovação** | nenhuma fonte |
| Promoções e descontos | **Indisponível** | nenhuma fonte |
| Rastreamento pelo assistente | **Indisponível** | exige identidade verificada (§8, L3) |

### Decisões que o comerciante precisa fornecer (modelos)

Preencha e registre a fonte (documento, data e quem aprovou). Cada item aprovado vira `situacao: 'confirmada'` com `texto` e `fonte` em `conhecimento.ts`.

```text
FORMAS DE PAGAMENTO
Aceitamos: [Pix | cartão de crédito em até N vezes | boleto | outro]
Condições: [ex.: parcelamento sem juros acima de R$ X]
Fonte/aprovação: [documento ou decisão, data, responsável]

FRETE E ENTREGA
Modalidades: [Correios PAC/SEDEX | transportadora | retirada]
Cálculo: [no checkout pelo CEP | tabela fixa | grátis acima de R$ X]
Regiões atendidas: [Brasil todo | ...]

PRAZO DE PREPARAÇÃO E POSTAGEM
Produtos em estoque: postagem em até [N] dias úteis após a confirmação do pagamento
Produtos sob encomenda: [N] dias úteis

TROCAS E DEVOLUÇÕES
Arrependimento: [7 dias corridos após o recebimento (CDC art. 49) | outro]
Defeito: [prazo e procedimento]
Quem paga o frete de retorno: [loja | cliente | depende do caso]
Como solicitar: [canal]

CANCELAMENTO E REEMBOLSO
Antes do envio: [como cancelar]
Prazo de reembolso: [N dias úteis; Pix/estorno no cartão]

DESCRIÇÕES DE PRODUTOS (por produto ou linha)
Produto: [nome exato do ERP]
Descrição aprovada: [texto curto, sem promessa terapêutica]
Indicação comercial: [para quem é / ocasião]
Diferença para [outro produto]: [...]
```

## 7. Atendimento e escalonamento

- **Intenção:** a triagem classifica a mensagem e sinaliza `precisaDeHumano`.
- **Informação complementar:** o assistente pede o número do pedido, o produto ou a preferência quando precisar, nunca dados sensíveis.
- **Reclamação, saúde, assunto jurídico, reembolso ou pedido de pessoa:** a triagem pede humano, a RPC `escalonar_triagem_ai_first` muda o controle para `HUMAN_REQUIRED` e uma nota privada é registrada. Daí em diante não há respostas automáticas.
- **Sem informação confirmada:** `acao: "encaminhar"`. O cliente recebe um texto acolhedor dizendo que a equipe vai continuar.
- **Takeover e handback:**
  - assumir invalida os envios automáticos em voo;
  - devolver exige resumo, que vira nota privada, e a IA retoma só a partir de uma mensagem nova, sem resposta retroativa;
  - a continuidade usa o resumo como contexto, nunca como instrução.
- **Ferramenta ou provedor indisponível:**
  - catálogo indisponível: o modelo é avisado e não cita preços;
  - provedor indisponível: há uma tentativa no alternativo e, se falhar, escalada para humano. Não existe retry oculto nem envio duplicado.

## 8. Segurança, confiabilidade e limitações

- **Isolamento:**
  - o worker é preso a uma organização e uma conexão, com escopo verificado por `verifyOrganizationScope`;
  - toda leitura do catálogo filtra `organizacao_id`, porque o service role ignora RLS;
  - as filas de claim seguem a invariante de conexão única por runtime (ver o runbook).
- **Separação cliente × comerciante:** o contexto A não tem ferramenta além do catálogo de vitrine. Custo, fornecedor, financeiro e clientes nunca entram no contexto.
- **Dados pessoais:** a entrada é mascarada antes do modelo e o assistente não pede dados sensíveis. O catálogo não traz quantidades exatas.
- **Prompt injection:** mensagens e resumos ficam delimitados como dados, as instruções proíbem segui-los e a validação de saída barra links, preços sem fonte e ações afirmadas.
- **Envio:** não muda. Há outbox com `command_id`, fencing token, versão de controle e recibo do Chatwoot.
- **Custo:** limite diário de gerações por inbox, limite de triagens por dia, `maxOutputTokens` 700, uma chamada por tentativa e no máximo um provedor alternativo.

### Limitações restantes
| # | Limitação | Próximo passo |
|---|---|---|
| L1 | As descrições das linhas vêm do briefing (12/10/2026), com composição provisória; os demais produtos não têm descrição | o comerciante confirma o texto final e descreve os outros produtos |
| L2 | Na escalada da triagem (pedido de pessoa ou reclamação), o cliente não recebe mensagem automática, só a equipe é avisada | migration: `concluir_geracao_ai_first` registrar texto de passagem e mudar o controle na mesma transação, para que o envio não seja invalidado |
| L3 | Sem consulta de pedido pelo cliente | verificar identidade (número do pedido + e-mail/telefone já cadastrado no ERP) antes de qualquer leitura |
| L4 | O worker serve uma organização fixa (`ORGANIZACAO_HAUX`) | runtime multi-organização com conhecimento por organização (o registro já é por id) |
| L5 | Recuperação por termos não entende sinônimos ("incenso" × "defumador") | sinônimos por organização na configuração e, depois, busca semântica |
| L6 | De 14 a 24 s até a resposta no widget, medidos por etapa. O Groq leva menos de 1 s. O resto é a espera dos workers (inbox de 2 a 5 s, envio de 1 a 4 s) e do laço do bot, que já não pausa quando há trabalho | reduzir o intervalo de consulta dos workers e o refresh de projeções ociosas (60 s, regra SQL), sem tocar em fences |
| L7 | Trocar a imagem do bot desliga o runtime (trava do SIGTERM) | reativação explícita e autorizada a cada deploy; runbook em `infra/worker/RUNTIME-HAUX.md` |
| L8 | A validação de saída é por regras: um texto fora delas pode ser recusado (e escalado), e uma afirmação nova e sutil pode passar | ampliar casos a partir dos logs `haux.resposta.recusada` |

## 9. Testes de aceitação

| # | Cenário | Esperado | Como é coberto |
|---|---|---|---|
| A | "Oi, bom dia." | saudação natural e abertura | smoke real e teste unitário |
| B | "Quanto custam os defumadores?" | preço do ERP (R$ 40,00) ou indisponibilidade clara | teste unitário (catálogo no prompt, preço validado) e smoke real com catálogo real |
| C | "Qual linha de defumador você recomenda?" | comparação pelo que existe, sem inventar propriedades e com pergunta de necessidade | smoke real |
| D | "Meu pedido já foi enviado?" | pede o número do pedido e diz que a equipe confirma, sem afirmar envio | instrução e validação (`acao_afirmada`) |
| E | "Quero devolver um produto." | política não informada: acolhe e encaminha | instrução, políticas "NÃO INFORMADA" e triagem |
| F | "Quero falar com uma pessoa." | `HUMAN_REQUIRED` sem novas respostas automáticas | triagem `precisaDeHumano` mais RPC; em L2, o cliente ainda não recebe mensagem |
| G | Devolução à IA e nova mensagem | retomada com contexto, sem duplicação | validação real na conversa 11 do WhatsApp |
| H–J | Comerciante: estoque baixo, vendas do mês, "exclua todos" | consulta real por permissão; exclusão em massa recusada | projetado em §5 (próxima etapa) |

## 10. Camada de ferramentas

O modelo **não** chama banco, RPC ou API. A aplicação escolhe e executa as ferramentas, valida o escopo e entrega ao modelo só o resultado, marcado como `[ferramenta]` ou `[ferramenta — FALHOU]`. A saída do modelo passa pela validação de §3 antes de qualquer envio.

### Cliente (P0, implementado neste PR)
| Ferramenta | O que faz | Fonte real | Escopo |
|---|---|---|---|
| `consultar_catalogo` | produtos vendáveis relacionados à conversa: nome, categoria, preço e disponível/sem estoque | `produtos` + `categorias` (espelho do Bling) | `organizacao_id` do worker; sem custo, fornecedor, quantidade ou imagem |
| `consultar_linhas` | linhas descritas pela marca (síntese, aroma, descrição, essências provisórias) e quais delas **não** têm item no ERP | `organizacoes/<org>.ts` | por organização |
| `consultar_politica_comercial` | políticas, chamada só quando a conversa trata de pagamento, frete, prazo, troca, devolução, cancelamento ou reembolso | `organizacoes/<org>.ts` | só as `confirmada` viram fato |

**Validações específicas** (além das de §3):
- preço só ao lado do **nome real** do item do ERP com esse valor;
- preço ou estoque afirmado para produto **sem cadastro** é recusado;
- o item não pode ser renomeado.

Todos esses casos foram vistos no smoke real e estão cobertos por teste.

### Mapeamento das ferramentas pedidas para o que existe no ORBITA
| Ferramenta | Estado | Serviço real que será reutilizado |
|---|---|---|
| consultar_catalogo / produto / preço / disponibilidade | **implementada** (`consultar_catalogo`) | `produtos`, `categorias` (repositório do catálogo, #114) |
| consultar_politica_comercial | **implementada** (sem políticas confirmadas ainda) | `organizacoes/<org>.ts` |
| consultar_pedido_autorizado (P1) | **a conectar** | `retratoDoPedido.ts` e `clienteVerificado.ts` (MSG-010/011); exige vínculo verificado conversa → cliente |
| consultar_vendas / pedidos / estoque / financeiro / estoque baixo (P2) | **a desenvolver como ferramenta** | serviços de vendas, estoque (`movimentacaoEstoqueRepository`) e financeiro já usados pelo painel; precisam de rota autenticada do comerciante |
| preparar_pedido / ajuste_estoque / troca / devolução / cancelamento / reposição (P2) | **a desenvolver**; a execução já existe por comando | `pedidos/manual` e `bling/pedidos/[id]` (#115), `produtos/update` (#114), cancelamento com estorno (#155). A IA só **prepara**; o comerciante confirma e o comando existente executa com idempotência e auditoria |

### Regras invariantes
- Uma conversa do Chatwoot nunca herda permissão do comerciante. O worker do cliente não tem ferramenta de escrita.
- Não existe SQL livre. As ferramentas são funções tipadas com escopo fixo.
- **P2:** ferramentas administrativas só em rota com sessão verificada (`VerifiedOrganizationScope`) e papel do membro. Ações que alteram estoque, valores, pedidos ou integrações passam por confirmação explícita e pelos comandos existentes (outbox, idempotência, auditoria).

## 11. Autorização para futuras operações de escrita

1. **Sessão verificada:** a operação nasce na sessão autenticada do comerciante (`VerifiedOrganizationScope` + papel com capacidade), nunca numa conversa do Chatwoot.
2. **Rascunho:** a IA monta um rascunho tipado com o comando, os parâmetros e o efeito esperado. Ela não executa.
3. **Confirmação:** a interface mostra o rascunho e pede confirmação explícita, que é obrigatória para estoque, valores, pedidos, cancelamentos e integrações externas.
4. **Execução:** é feita pelo comando que já existe (#114, #115, #155), com `command_id` idempotente, outbox quando houver integração e evento de auditoria com `ator_id`.
5. **Proibições:** operações em massa ("excluir todos os produtos") não têm ferramenta e são recusadas com explicação.
