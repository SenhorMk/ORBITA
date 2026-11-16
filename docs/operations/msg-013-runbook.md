# Triagem por IA do caso SAC (MSG-013) — migration 94_triagem_ia_sac.sql

Cada caso SAC em TRIAGE recebe uma triagem por IA: o que a pessoa quer, o
motivo, o número de pedido que ela citou, o que falta perguntar e se precisa de
atendente. O resultado é **hipótese**: aparece no cockpit para o atendente e
nunca é enviado à cliente nem muda o caso.

**Só dados sintéticos até o MSG-021.** O caminho inicial é o Gemini Flash pela
API do Google; no plano gratuito, o Google pode usar o conteúdo enviado.

## 1. Caminho

```text
inbox (MSG-006) abre o caso ou grava mensagem nova
  → gatilho em sac_cases enfileira outbox interno/sac.triagem
    (chave: caso + momento da última mensagem; sem segunda fila)
worker (npm run worker:triagem)
  → reivindicar_triagens_sac           só interno/sac.triagem, lease + fencing
  → iniciar_triagem_sac                posse, versão do caso, orçamento do dia,
                                       até 5 mensagens do contato (cortadas)
  → executarTriagem                    mascara CPF/CNPJ/cartão/e-mail/telefone,
                                       bloqueia credencial, chama o modelo,
                                       valida o schema, uma reparação
  → concluir_triagem_sac               grava o desfecho, revalida a versão e
                                       fecha o evento na mesma transação
cockpit: GET /api/sac/triagem?conversaId=…  → painel "Triagem"
```

| Peça | Onde |
|---|---|
| Execuções | `ai_runs` (sem privilégio direto, nem para `service_role`) |
| Funções | `reivindicar_triagens_sac`, `iniciar_triagem_sac`, `concluir_triagem_sac`, `ler_triagem_do_caso_sac` (só `service_role`) |
| Domínio | `src/services/sac/triagem/triagemDoCaso.ts` (entrada, prompt, reparação, desfechos) |
| Modelos | `src/services/sac/triagem/modelosDeTriagem.ts` (AI SDK + Gemini; modelo falso declarado) |
| Worker | `src/services/sac/triagem/consumidorTriagem.ts`, `workerTriagem.ts`, `scripts/worker-triagem-sac.ts` |
| Contrato | `src/lib/integrations/contratoDaTriagem.ts` (schema v1 da triagem e contrato HTTP v1) |
| Tela | `src/components/mensageria/PainelDaTriagem.tsx` |

## 2. Regras

- **Contexto mínimo.** Vão ao modelo só as últimas 5 mensagens recebidas do
  contato no caso, cada uma com até 2000 caracteres. Nada do cadastro, nada do
  atendente. CPF, CNPJ, cartão (Luhn), e-mail e telefone são mascarados.
  Mensagem com credencial (JWT, chave de API, chave privada, "senha:") não vai:
  o caso fica com o atendente (`entrada_bloqueada`).
- **Injeção de prompt.** O texto da cliente vai delimitado e neutralizado
  (`<` e `>` trocados), e as instruções mandam nunca seguir ordens de dentro
  dele. O modelo não tem ferramentas: só devolve o objeto do schema.
- **Schema estrito.** Campos fechados; campo a mais é inválido. Fora do schema:
  uma reparação; falhou de novo, `handoff` por `schema_invalido`.
- **Desfechos.** `concluida`: resultado gravado. `handoff` (`recusa`,
  `schema_invalido`, `entrada_bloqueada`, `sem_orcamento`): fica com o
  atendente, o evento fecha. `falha` (`limite_do_provedor`, `timeout`,
  `erro_do_provedor`): volta à fila com espera (429 respeita o Retry-After,
  mínimo 60 s), até 3 tentativas; depois `dead_letter`.
- **Nunca efeito desconhecido.** A chamada ao modelo acontece com o evento em
  `processing`. Queda no meio: a lease vence, o reaper devolve à fila e a
  execução antiga fica `falha/interrompida` (contando no orçamento). O evento só
  passa por `in_flight` dentro da transação que grava o resultado.
- **Versão do caso.** Cada trabalho se refere à última mensagem quando foi
  enfileirado. Mensagem nova antes do início: `obsoleta`, sem chamar o modelo.
  Mensagem nova durante a execução: o resultado fica como histórico
  (`obsoleta`), e a triagem enfileirada pela mensagem nova é a que vale.
- **Orçamento.** `SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO` execuções por dia
  (dia de Brasília), contadas sob trava por organização: em andamento e as que
  chamaram o modelo. Padrão 0: ligado sem limite, nada chama o modelo.
- **Modelos aprovados.** Só a família Flash do Gemini (`gemini-…-flash`),
  validada no código. Outro modelo é mudança de código e de runbook.
- **Logs.** `sac.triagem.*` com correlação, organização, caso, evento,
  execução, desfecho, motivo, tokens, latência e o booleano `precisaDeHumano`
  (taxa de handoff). Nunca o texto da cliente nem os campos livres da triagem.

## 3. Operar

Variáveis (nomes em `.env.example`): `SAC_TRIAGEM_WORKER_ENABLED`,
`SAC_TRIAGEM_PROVEDOR` (`google` ou `fake`), `SAC_TRIAGEM_MODELO`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO`,
`SAC_TRIAGEM_TIMEOUT_MS`, `SAC_TRIAGEM_LEASE_SECONDS`, `SAC_TRIAGEM_BATCH`,
`SAC_TRIAGEM_POLL_MS`, `SAC_TRIAGEM_IDLE_MAX_MS`.

- **Sem chave:** `SAC_TRIAGEM_PROVEDOR=fake`. O painel diz "modelo falso, sem
  IA real" e todo caso pede atendente.
- **Com chave (DEV sintético):** crie a chave no Google AI Studio, ponha no
  `.env.local`, `SAC_TRIAGEM_PROVEDOR=google`, `SAC_TRIAGEM_MODELO=gemini-2.5-flash`
  (ou o Flash vigente), um limite diário pequeno, e rode `npm run worker:triagem`.
- **Desligar (triagem manual):** `SAC_TRIAGEM_WORKER_ENABLED=false`. As
  triagens ficam na fila e o painel mostra "Triagem na fila". Nada se perde.
- **Ao ligar:** a fila acumulada com o worker desligado é processada, a mais
  antiga primeiro, e gasta orçamento. Triagem de caso que recebeu mensagem
  depois vira `obsoleta` sem chamar o modelo; as demais rodam. Comece com um
  limite diário pequeno.
- O worker ainda não está no pacote de workers do notebook (MSG-020C): roda
  com `npm run worker:triagem`.

## 4. Decisões para a proprietária

1. **D3:** chave e teto diário para o teste com modelo real em DEV. Até lá, o
   aceite "modelo real produz schema validado" fica pendente.
2. **D6/MSG-021:** antes de dado real, plano pago (sem uso do conteúdo pelo
   provedor), DPA e retenção de `ai_runs`.
3. Limites escolhidos na implementação: 5 mensagens, 2000 caracteres, 3
   tentativas, 20 s por chamada, uma reparação. Confirmar ou ajustar.

## 5. Implantação da migration 94

Numerada depois da 93 (MSG-011, PR #148). Se a #148 entrar antes, esta branch é
rebaseada e o ledger e o catálogo regenerados.

| Banco \ App | App anterior | App deste PR |
|---|---|---|
| **Sem a 94** | funciona | O painel "Triagem" mostra erro (RPC ausente); o worker não sobe trabalho. O resto funciona |
| **Com a 94** | funciona: os casos passam a enfileirar triagens que ninguém consome (ficam `pending`) | funciona |

Ordem, cada passo com autorização explícita:

1. **Conferir o alvo, só leitura:** `npm run db:remoto:status` mostra só a 94 pendente.
2. **Aplicar a 94** (`npm run db:remoto:aplicar`). Impacto: troca a constraint
   de destino de `outbox_eventos` (`not valid` + `validate`: trava breve de
   escrita e uma varredura da tabela), recria `reivindicar_tentativas_outbox`
   com o filtro de destino, cria `ai_runs`, um gatilho em `sac_cases` e seis
   funções. Nenhuma linha existente muda. `lock_timeout = 5s`.
3. **Validar, só leitura:**

   ```sql
   select has_table_privilege('service_role', 'public.ai_runs', 'select');  -- false
   select count(*) from public.outbox_eventos where destination = 'interno'; -- cresce com casos novos
   ```

4. **Merge** (autorização separada).

### Rollback

- **App/worker:** desligar o worker (`SAC_TRIAGEM_WORKER_ENABLED=false`) e,
  se preciso, reimplantar o app anterior.
- **Banco:** forward-only. Para parar de enfileirar sem migration:
  `alter table public.sac_cases disable trigger tg_sac_caso_enfileirar_triagem;`.
  Preservar `ai_runs` e os eventos; não reprocessar triagens já usadas.

## 6. Verificação

```bash
npx vitest run src/services/sac/triagem src/app/api/sac/triagem src/components/mensageria
```

```bash
npm run test:db
```
