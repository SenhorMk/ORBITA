# Portal do Haux: base de conhecimento do assistente

Este documento é o espelho legível do que o assistente consome em `src/services/sac/assistente/organizacoes/portalDoHaux.ts`. Ele vale **só para o Portal do Haux** (organização `c75eb92d…`); nada aqui é regra global do ORBITA.

- **Preço, disponibilidade e catálogo** vêm sempre do ERP (Bling via Supabase), nunca deste arquivo.
- **Alterações** passam pelo arquivo `.ts` e pelo teste correspondente, e este documento acompanha.

## Identidade e tom de voz
- **Identificação** no início de cada resposta automática: "Assistente virtual do Portal do Haux".
- **Tom:** acolhedor, respeitoso e direto, em português do Brasil. Usa a linguagem ritual e simbólica da marca, sem promessa de efeito.
- **Fonte:** `PortaldoHaux/docs_desing/BRAND.md` e o briefing de defumadores.

## Linhas de defumador: Luz, Purificação, Harmonia e Guardião
- **Fonte:** *Portal do Haux, Briefing Defumadores Completo*, revisão de 12/10/2026, fichas DEF 001–004, textos na "versão do briefing enviado" pelo Portal.
- **Situação:** as descrições são **linguagem da marca fornecida pelo comerciante**. Composição, volume e textos técnicos estão **provisórios** no próprio briefing.
- **Formato:** as quatro são defumadores líquidos de ambiente, para borrifar no espaço.

| Linha | Síntese da força | Perfil aromático | Essências (provisório) | Para quem busca |
|---|---|---|---|---|
| Portal de Luz (DEF 001) | elevação, clareza e conexão espiritual | floral, delicado, levemente herbal e luminoso | jasmim e alecrim | leveza, clareza, acolhimento e inspiração |
| Portal de Purificação (DEF 002) | limpeza, descarrego e renovação | herbal, verde, fresco e marcante | arruda, eucalipto, alecrim e lavanda | renovar o ambiente e abrir caminhos |
| Portal de Harmonia (DEF 003) | serenidade, equilíbrio e harmonização | fresco, herbal, levemente cítrico e floral | capim-limão, lavanda e alecrim | calma, descanso e equilíbrio no ambiente |
| Portal do Guardião (DEF 004) | proteção, firmeza e força ancestral | quente, intenso, especiado e amadeirado | cravo, canela, patchouli e lavanda | presença, firmeza e resguardo |

### Critérios de recomendação
1. **Necessidade:** relacionar o que a pessoa descreveu (calma, limpeza, proteção, leveza) com a síntese de cada linha.
2. **Aroma:** quando a necessidade não define a escolha, perguntar a preferência (floral e leve, herbal e fresco, quente e especiado).
3. **Preço:** citar só os que estão no catálogo do ERP. Linha sem item no ERP tem o preço "ainda não cadastrado".
4. **Limites:** nunca prometer efeito terapêutico ou espiritual garantido, porque as descrições são linguagem simbólica da marca.
5. **Cuidados:** uso ambiental; não ingerir nem aplicar na pele.

### Situação no ERP (23/11/2026)
- **Cadastrado:** o catálogo tem "Defumador - Limpeza e descarrego" (R$ 40,00, disponível).
- **Linhas sem cadastro:** as quatro linhas da família ainda **não estão cadastradas como produtos**, então o assistente informa que o preço delas não está disponível.
- **Associação:** o assistente não associa o produto cadastrado a uma linha sem confirmação.

## Perguntas frequentes
| Pergunta | Resposta esperada |
|---|---|
| "Quais defumadores vocês têm?" | o item do ERP com preço e as quatro linhas descritas pela marca, com o aviso de preço quando não estiver cadastrado |
| "Qual você recomenda para harmonizar o ambiente?" | Portal de Harmonia, pela síntese e pelo aroma, com uma pergunta de preferência se ajudar |
| "Vocês têm disponível?" | disponibilidade do ERP ("disponível" ou "sem estoque no momento"), sem quantidade exata |
| "Como uso?" | borrifar suavemente no ambiente, como produto de uso ambiental. O modo de uso final está provisório no briefing |

## Políticas comerciais
Nenhuma está confirmada até agora. A situação de cada tema e os modelos de preenchimento estão em `docs/ai/ASSISTENTE_ORBITA.md` §6.

| Tema | Situação |
|---|---|
| Pagamento, frete, prazos, trocas, cancelamento e reembolso | pendente de aprovação |
| Promoções | indisponível |
| Rastreamento pelo assistente | indisponível (P1) |

## Encaminhamento humano
- **Gatilhos:** reclamação, saúde ou uso terapêutico, assunto jurídico, pedido de reembolso, pedido explícito de pessoa ou política não informada que a pessoa precisa resolver.
- **Ao cliente:** o assistente diz que a equipe vai continuar o atendimento. A escalada automática pela triagem ainda não envia essa mensagem: ver limitação L2.

## O que o comerciante ainda precisa fornecer
- Confirmação das descrições, da composição final e do volume das quatro linhas.
- Cadastro das quatro linhas no ERP (Bling), com preço.
- Se "Defumador - Limpeza e descarrego" corresponde a alguma linha.
- Políticas comerciais (§6 do documento principal).
