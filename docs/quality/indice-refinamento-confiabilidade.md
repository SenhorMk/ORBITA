# Índice de acompanhamento — série de refinamento de confiabilidade

Atualizado em 31/08/2026.

## O que este documento é, e o que não é

É um **resumo de acompanhamento**: estado, PRs e próxima ação de cada ticket da
série. Serve para responder "onde isto parou" sem abrir dezoito arquivos.

**Ele não substitui nada.** Os critérios de aceitação e a evidência vivem em
outro lugar (abaixo). Se este resumo divergir de um deles, o ticket e a
evidência é que valem, e o erro é aqui. Este arquivo não revoga critério nem
dispensa prova.

## Onde ficam os critérios e as evidências

| O quê | Onde | Versionado? |
|---|---|---|
| Critérios de aceitação, um arquivo por ticket | `.scratch/orbita-refinamento-confiabilidade/issues/NN-*.md` | **não** |
| Evidência de execução (jornadas, resultados) | `.scratch/orbita-refinamento-confiabilidade/evidence/` | **não** |
| Contexto da sessão e fatos operacionais | `.scratch/orbita-refinamento-confiabilidade/HANDOFF-*.md` | **não** |
| Este índice | `docs/quality/` | **sim** |

`.scratch/` é área de trabalho e o git a ignora — por decisão do projeto, e não
por descuido. A consequência precisa ser dita: **quem clona o repositório não
abre os tickets**. Este índice é versionado justamente para que o estado da
série não dependa de uma pasta local, mas ele é um ponteiro, não a fonte.

Não mover o resto de `.scratch/` para cá sem decisão própria: parte do conteúdo
é evidência de execução contra a conta real do Bling e o banco de
desenvolvimento.

## Numeração — não renumerar

A sequência é **`01–07, 09–18`**. Não existe ticket 08: ele virou o **18**. Os
antigos **30–33** da série `orbita-mvp-producao-v2` são hoje **12–15**. Esses
números já aparecem em commits e PRs mesclados; renumerar quebraria o rastro.

**Complementos não são tickets novos.** `03b` e `11b` são fatias dos tickets
**03** e **11**; `05b` é fatia do **05**. Estão agrupados no ticket de origem.

## Vocabulário de estado

| Estado | Significa |
|---|---|
| **concluído** | critérios atendidos e evidência registrada. Nada pendente. |
| **entregue, pendência aberta** | o código está mesclado, mas um critério do próprio ticket não foi cumprido |
| **parcial** | parte dos critérios comprovada, parte não |
| **em revisão** | PR aberto, aguardando merge |
| **aberto** | não começou |

`done` não é usado onde há correção ou aceite pendente.

**Dívida preservada não é aceite pendente.** Quando o próprio ticket manda
preservar um comportamento — como o 04 exigiu ao pedir comportamento externo
idêntico — o resíduo é melhoria futura, e o ticket fecha. Só vira pendência o
que o ticket pediu e não foi entregue.

## Índice

| # | Assunto | Estado | PRs | Evidência que falta | Próxima ação |
|---|---|---|---|---|---|
| 01 | Jornada real do Bling em leitura | concluído | — | — | — |
| 02 | Detectar migrações pendentes | concluído | #45 | — | — |
| 03 | Erro do servidor sempre legível (inclui **03b**: política de redação única) | concluído | #52 · #55 · #57 | — | — |
| 04 | Costura de teste em `pedidos/status` (inclui reparo **CWE-209**) | concluído | #53 | — | Dois `catch` ficaram marcados `DÍVIDA (preservada)` no código: preservá-los era o critério, não o descumprimento dele. Melhoria futura, não reabre o ticket |
| 05 | Costura de teste em `financeiro/sync` (inclui **05b**) | concluído | #56 · #58 · #59 (`a7b747d`) | — | — |
| 06 | Guarda de payload de **escrita** contra o schema oficial | **aberto** | — | — | Validar o payload que o adapter serializa de fato, não uma fixture; distinguir corpo, caminho e query |
| 07 | Ambiente de staging e specs Playwright | **entregue, pendência aberta** | #49 | Prova de que seed e limpeza não deixam resíduo entre execuções | Transformar em tickets as 3 causas-raiz das 7 specs vermelhas — é critério do próprio 07 |
| 09 | Venda manual quebrada em produção | concluído | #44 | — | — |
| 10 | Venda manual tudo-ou-nada | concluído | #48 | — | — |
| 11 | Webhook fecha a volta Bling→ORBITA (inclui **11b**) | **entregue, pendência aberta** | #51 · #54 | Evidência fim a fim contra a conta real | É o ticket **16**. Enquanto não fechar, não afirmar que o webhook reconcilia divergência |
| 12 | Bling: vendas/pedidos e pedido manual | **parcial** | — | Criação **pela UI**; erro do Bling legível na tela | Ver conciliação abaixo |
| 13 | Bling: estoque/produtos e cadastro | **parcial** | — | Cadastro de produto pela interface | Cadastrar pelo modal e mostrar a linha em `produtos` com `bling_id` + o produto no painel do Bling |
| 14 | Bling: clientes/contatos e novo contato | **parcial** | — | Cadastro de contato pelo modal | Idem, pelo modal de contato. O caminho indireto da venda manual não substitui |
| 15 | Bling: financeiro e nova despesa | **aberto** | — | Nenhuma evidência cobre o financeiro | Lançar despesa pelo modal e conferir no painel do Bling. Responder também se `historico` e `pagamento.data` existem na resposta real (herdado do 05) |
| 16 | Evidência fim a fim do webhook | **aberto** | — | — | Depende tecnicamente do #54, já mesclado. Provar tentativas e efeito único **separadamente**: uma linha no inbox não prova ausência de reentrega |
| 17 | Identidade de serviço no webhook | **aberto** | — | — | Escopo limitado ao caminho do webhook. Não tornar `actorId` opcional nos repositórios sem proposta aprovada |
| 18 | Remover referências a Strix (era o 08) | **aberto, último** | — | — | Nada depende dele. Remover referência local não desabilita revisão de segurança |

## Conciliação do 07 — critério a critério

| Critério | Estado |
|---|---|
| Staging de pé, banco próprio, nunca apontando para produção | ✅ |
| `STAGING_URL` e credenciais de seed documentadas | ✅ |
| As cinco specs executam e o resultado de cada uma é registrado | ✅ — 12 de 19; as 7 falhas triadas em 3 causas prováveis |
| Spec que falha por defeito real vira **ticket próprio** | ❌ nenhum ticket criado |
| Seed e limpeza sem resíduo entre execuções | ❌ os comandos existem; nada registrado |
| Documentado como rodar | ✅ |

**Não exigir todos os testes verdes para encerrar o 07.** O ticket separa
preparar ambiente de corrigir produto, e a separação é deliberada. O que falta é
o que ele mesmo pede: transformar as falhas em tickets, e provar que a limpeza
não deixa resíduo.

As 3 causas prováveis, já triadas:

1. erro de login não exposto em elemento alcançável (specs `identity` e `accessibility`);
2. `verifySessionAndRole` devolve `null` tanto para "sem sessão" quanto para "sem capacidade", e as duas viram 401 — a segunda deveria ser 403 (specs `cross-tenant-denial` e `organization`);
3. ordem de tabulação das abas, não investigada.

## Conciliação do 12 — critério a critério

| Critério | Estado |
|---|---|
| Criar pedido manual **pela UI** cria no Bling e reflete o ID real | ⚠️ parcial — comprovado **pela API**, não pela interface |
| Erro do Bling legível, sem mascarar como sucesso | ⚠️ parcial — coberto por teste do handler; nada observado em tela |
| Divergências contrato × doc oficial corrigidas e documentadas | ✅ `bling-v3-paths.json`, `bling-v3-schemas.json` |
| Escopo por organização em todas as queries da fatia | ✅ |
| Gates completos verdes | ✅ |

**A evidência existente vale e não deve ser refeita.** O pedido real foi criado
e apareceu na listagem local — isso está provado. Falta só o recorte da UI: a
mesma jornada pelo modal de venda manual, e um erro do Bling chegando legível à
tela.
