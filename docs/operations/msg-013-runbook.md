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
  (`obsoleta`), e a triagem enfileirada pela mensagem nova é a que vale. A
  conclusão lê o caso `for share`: segue a ordem de commit com a inbox (provado
  com barreiras em `scripts/database-concurrency-triagem.mjs`).
  A versão avança a cada mensagem aplicada pela inbox, mesmo no mesmo segundo
  da anterior (o Chatwoot manda `created_at` em segundos) ou atrasada:
  `tg_sac_caso_versao_da_mensagem` soma 1 µs quando a transação é da inbox
  (`aplicar_evento_inbox_chatwoot` marca `orbita.aplicando_inbox`). Um UPDATE
  sem mensagem nova não muda nada (pgTAP 7, 36–39).
- **Orçamento.** `SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO` execuções por dia
  (dia de Brasília), contadas sob trava por organização: em andamento e as que
  chamaram o modelo. Padrão 0: ligado sem limite, nada chama o modelo.
- **Modelos aprovados.** Só os de texto da família Flash do Gemini
  (`gemini-2.5-flash`, `-lite`, `-001`, `-preview`), validados no código.
  Variantes `-image`, `-tts` e `-native-audio-*` ficam fora: não geram o objeto
  da triagem. Outro modelo é mudança de código e de runbook.
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
- **Teste do modelo real (D3), sem banco:** a proprietária cria a chave no
  Google AI Studio e a grava no `.env.local` do checkout onde vai rodar
  (`GOOGLE_GENERATIVE_AI_API_KEY`), com `SAC_TRIAGEM_MODELO=gemini-2.5-flash`.
  A chave nunca vai para chat, argumento, commit ou log. `npm run smoke:triagem`
  confere a configuração e mostra o plano sem chamar nada;
  `npm run smoke:triagem -- --confirmar` envia as 8 fixtures sintéticas
  (7 chegam ao modelo, no máximo 14 chamadas) e imprime só desfecho,
  intenção, tokens e latência. Aprovado = 7/7 com schema validado e a fixture
  com senha bloqueada antes do modelo. Anexar a saída à evidência do ticket.
- **Com chave, pelo worker (DEV sintético):** depois do smoke, com a migration 94
  no banco de destino: `SAC_TRIAGEM_PROVEDOR=google`, o mesmo modelo, um limite
  diário pequeno, e `npm run worker:triagem`.
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

## 5. Integração com a `main` (93 já mesclada) e implantação da migration 94 (preflight)

A #148 (MSG-011, migration 93) foi mesclada na `main` em `dba206c`. O #149 foi
integrado localmente por merge da `main` (sem rebase, então sem force-push): a
93 fica na ordem 96 e a 94 na ordem 97. A 93 só cria uma função; a 94 não
toca em nenhum objeto da 93.

**Estado medido no Staging (`etqjqeqqbjrzyyxodntv`), só leitura, 16/11/2026:**
95 migrations aplicadas (até a 92); `ai_runs`, a função da 93 e a da 94 não
existem; `outbox_eventos` com 0 linhas (80 kB) e `sac_cases` com 0 linhas. A
única check da outbox que menciona `destination` é
`outbox_eventos_destination_check`, a que a 94 substitui. Nunca aplicar a 94 a
partir de uma base sem a 93: a partir do #149 antigo, o status a planejava como
ordem 96.

| Banco \ App | App anterior | App deste PR |
|---|---|---|
| **Sem a 94** | funciona | O painel "Triagem" mostra erro (RPC ausente); o worker não sobe trabalho. O resto funciona |
| **Com a 94** | funciona: os casos passam a enfileirar triagens que ninguém consome (ficam `pending`) | funciona |

Ordem. Cada passo remoto exige autorização explícita, separada:

1. **93 no Staging**, a partir de um checkout da `main` (`dba206c`), não do
   #149 (que planejaria a 93 e a 94 juntas): `npm run db:remoto:status` tem de
   planejar só `ordem 96 93_retrato_do_pedido_sac.sql`. A 93 só cria uma
   função (sem tabela, sem trava relevante). Validação: a função existe e só
   `service_role` executa.
2. **Fechar a integração do #149**, local:
   - feito: `supabase/config.toml` com a 93 e depois a 94; teste de drift com
     98 arquivos e 97 migrations; ledger regravado (`db:drift:check` verde);
     linhas 28f e 28g do inventário presentes;
   - feito também: `npm run db:catalog:rebuild` (fingerprint `173ee942…`) e
     `npm run test:db` com a cadeia 93 → 94, dois ciclos limpos;
   - depois: `git push` comum (autorização separada) e CI verde no novo HEAD.
3. **Conferir o alvo**, só leitura, a partir do #149 integrado e com a 93 já
   aplicada: `npm run db:remoto:status` tem de planejar só
   `ordem 97 94_triagem_ia_sac.sql` com o checksum do ledger. Qualquer outra
   coisa: parar.
4. **Aplicar a 94** (`npm run db:remoto:aplicar -- --confirmar`), com os workers
   do notebook parados. Travas, todas sob `lock_timeout = 5s` (falha rápido e
   pode ser repetida):
   - `outbox_eventos`: `ACCESS EXCLUSIVE` breve para trocar a check de destino
     (`not valid`), depois `SHARE UPDATE EXCLUSIVE` no `validate` (varredura;
     0 linhas hoje);
   - `sac_cases`: `SHARE ROW EXCLUSIVE` para criar os dois gatilhos;
   - `aplicar_evento_inbox_chatwoot` renomeada para `..._base_msg013` e
     substituída por um invólucro com a mesma assinatura e os mesmos grants
     (`service_role`, `orbita_worker_inbox`). O worker da inbox também deve
     estar parado;
   - `reivindicar_tentativas_outbox` recriada com o filtro de destino;
   - cria `ai_runs` e seis funções. Nenhuma linha existente muda.
5. **Validar**, só leitura:

   ```sql
   select has_table_privilege('service_role', 'public.ai_runs', 'select');            -- false
   select conname, convalidated from pg_constraint
    where conrelid = 'public.outbox_eventos'::regclass
      and conname in ('ck_outbox_eventos_destination', 'ck_outbox_eventos_interno', 'outbox_eventos_destination_check');
   -- as duas novas, convalidated = true; a antiga, ausente
   select count(*) from pg_trigger
    where tgname in ('tg_sac_caso_enfileirar_triagem', 'tg_sac_caso_versao_da_mensagem');  -- 2
   select has_function_privilege('orbita_worker_inbox', 'public.aplicar_evento_inbox_chatwoot(uuid,text,bigint,jsonb)', 'execute');          -- true
   select has_function_privilege('orbita_worker_inbox', 'public.aplicar_evento_inbox_chatwoot_base_msg013(uuid,text,bigint,jsonb)', 'execute'); -- false
   select attidentity from pg_attribute where attrelid = 'public.ai_runs'::regclass and attname = 'sequencia'; -- 'a'
   select has_function_privilege('authenticated', 'public.ler_triagem_do_caso_sac(uuid,uuid)', 'execute'); -- false
   ```

6. **Merge do #149** (autorização separada). O worker continua desligado e o
   orçamento em 0 até o teste do modelo real.

### Rollback

- **App/worker:** desligar o worker (`SAC_TRIAGEM_WORKER_ENABLED=false`) e,
  se preciso, reimplantar o app anterior. As duas linhas da tabela acima
  funcionam com o app anterior.
- **Banco, sem migration:** parar de enfileirar com
  `alter table public.sac_cases disable trigger tg_sac_caso_enfileirar_triagem;`.
  O claim genérico da outbox já ignora `interno`. Preservar `ai_runs` e os
  eventos; não reprocessar triagens já usadas.
- **Banco, reversão completa:** só por migration nova, forward-only (remover
  gatilho e funções; voltar a check de destino sem `interno` exige antes não
  haver linhas `interno`). A 93 só tem uma função: reverter é revogar ou
  remover por migration nova. Nunca `--adotar`.

## 6. Verificação

```bash
npx vitest run src/services/sac/triagem src/app/api/sac/triagem src/components/mensageria
```

```bash
npm run test:db
```
