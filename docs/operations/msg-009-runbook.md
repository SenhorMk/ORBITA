# Controle do atendimento (MSG-009) — migration 91_controle_atendimento_chatwoot.sql

Cada conversa tem **um único dono lógico**: a automação (`AI`), ninguém até um
atendente assumir (`HUMAN_REQUIRED`) ou um atendente (`HUMAN`). Toda mudança
incrementa `control_version`, invalida no banco as respostas ainda na fila e
informa as que podem ter chegado à cliente. Arquivo na ordem 94 do ledger, sobre
a `main` `3d62493` (MSG-008 integrado).

**Nenhuma automação responde hoje.** Não existe configuração, worker nem modelo
de resposta automática (MSG-013/MSG-014). Por isso:

- `automacaoDoAtendimentoAtiva()` (`src/services/chatwoot/automacaoDoAtendimento.ts`)
  devolve `false` para todos. É a única fonte que a rota e a tela consultam.
- A rota recusa `devolver` com **409 `automacao_inativa`** antes de chamar o
  banco: devolver deixaria a conversa sem ninguém.
- A tela mostra uma conversa em `AI` como **"Sem atendente"**, com o aviso de que
  a automação ainda não responde e o botão Assumir. Nunca "Automação responde".
- Responder uma conversa em `AI` a assume (regra do MSG-008 abaixo), então ela
  não fica esperando uma IA que não existe.

O contrato da migration (`AI`, `devolver`) fica pronto para a automação; ligá-la
é decisão e entrega de MSG-013/MSG-014.

## 1. Caminho

```text
cockpit: GET  /api/chatwoot/controle?conversaId=…
              ler_controle_atendimento_chatwoot → 404 se a conversa não é da organização da sessão
              → { controle: { modo, responsavelId, souResponsavel, versao },
                  permissoes: { devolver, motivoSemDevolver, automacaoAtiva } }
         POST /api/chatwoot/controle { conversaId, commandId, acao, versaoEsperada, nota? }
              alterar_controle_atendimento_chatwoot: CAS na versão, histórico, nota privada,
              invalidação da fila e auditoria, numa transação
         POST /api/chatwoot/send (MSG-008): responder conversa sem dono a assume;
              conversa de outra pessoa → 409 outro_responsavel
worker:  reivindicar_envios_chatwoot(…, p_protocolo = 2) → devolve `privada`
         → iniciar_envio_chatwoot: confere a versão sob trava compartilhada antes de in_flight
           (versão vencida → dead_letter sem chamar o Chatwoot). É o único caminho:
           iniciar_despacho_outbox (genérico) recusa evento de chatwoot_envios com 55000
         → mensagem: sendMessage (private: false) · nota: sendPrivateNote (private: true)
         → concluir_envio_chatwoot: nota confirmada não vira mensagem espelhada
```

| Peça | Onde |
|---|---|
| Controle e histórico | `chatwoot_conversa_controle`, `chatwoot_controle_historico` (só leitura para `service_role`) |
| Leitura e mudança | `ler_controle_atendimento_chatwoot`, `alterar_controle_atendimento_chatwoot` (só `service_role`) |
| Início do despacho | `iniciar_envio_chatwoot` (o genérico `iniciar_despacho_outbox` recusa envios do Chatwoot) |
| Rota | `src/app/api/chatwoot/controle/route.ts` |
| Serviço | `src/services/chatwoot/controleAtendimento.ts`, `automacaoDoAtendimento.ts` |
| Tela | `src/components/mensageria/useControle.ts`, `BarraDoAtendimento.tsx` |

## 2. Regras

| Ação | De | Para | Quem | Exige |
|---|---|---|---|---|
| `assumir` | qualquer estado, salvo já ser seu | `HUMAN`, você | `organization:access` | versão vigente; nota opcional. Conversa de outra pessoa: a tela pede confirmação (transferência) |
| `devolver` | `HUMAN` seu | `AI` | `organization:manage` (rota e banco) e **automação ativa** (rota) | versão vigente; **resumo obrigatório** |
| `exigir_humano` | `AI` | `HUMAN_REQUIRED` | `organization:access` | versão vigente; nota opcional |
| responder (MSG-008) | `AI`, `HUMAN_REQUIRED`, `HUMAN` sem dono ou com dono fora da organização | `HUMAN`, você | `organization:access` | — (assume na mesma transação) |

| Resultado | HTTP | Significado |
|---|---|---|
| `aplicado` / `existente` | 200 | mudou; `existente` é a repetição do mesmo `commandId` com os mesmos dados (inclusive depois de transições posteriores: nada é reaplicado, a resposta traz o controle atual) |
| `conflito_versao` | 409 | outra aba ou pessoa mudou antes; a resposta traz o controle atual |
| `transicao_invalida` | 409 | a ação não vale para o estado atual |
| `conflito_comando` | 409 | mesmo `commandId` com outros dados |
| `automacao_inativa` | 409 | `devolver` sem automação ativa; o banco não é chamado |
| `sem_capacidade` / `sem_vinculo` | 403 | sem permissão / fora da organização |
| `conversa_inexistente` | 404 | conversa de outra organização ou inexistente (POST e GET) |
| erro do banco ou resposta fora do contrato | 503 | nada mudou |

**Permissões na tela.** O servidor calcula `permissoes` a partir do escopo
verificado: `devolver` só é verdadeiro para quem é o responsável, tem
`organization:manage` e com automação ativa. Senão `motivoSemDevolver` diz por
quê (`nao_e_responsavel`, `sem_capacidade`, `automacao_inativa`) e a tela mostra
o motivo no lugar do botão. A rota e a RPC conferem tudo de novo.

- **Fila.** A mudança invalida as respostas com versão anterior que estão sem
  dono e comprovadamente não saíram:
  - `pending` → `dead_letter` (transição da migration 86);
  - `failed_transient` → `processing` → `dead_letter`, na mesma transação. A
    máquina da 86 não tem `failed_transient` → `dead_letter`; a invalidação usa
    o caminho que ela já admite (reivindicar e recusar), e o gatilho sobe o
    fencing token. `failed_transient` só nasce de `nao_enviado` (prova de não
    aplicação) ou de `processing` vencido (nunca despachou).

  As duas recebem `last_error` fixo, categoria `permanent` e
  `chatwoot_envios.invalidado_em`, e entram na contagem `invalidados` que a tela
  mostra. As que estão com um worker (`processing`) são invalidadas em
  `iniciar_envio_chatwoot`, que espera a trava do controle. A saúde da conexão
  não muda.
- **Pode ter chegado.** `in_flight` e `unknown` (salvo `unknown` já provado não
  aplicado) não são desfeitos nem cancelados: a mudança devolve `em_voo` e a tela
  avisa que a resposta pode ter chegado à cliente. Seguem o protocolo da outbox
  (recibo, reconciliação, nunca replay de `unknown`).
- **Nota privada.** Cada mudança registra uma intenção `privada` (`message.note`)
  com texto fixo + nota/resumo, despachada com `private: true`. Ela não é
  invalidada por mudanças posteriores, só é confirmada se o recibo disser
  `private: true` (senão `unknown`, para inspeção) e nunca vira mensagem no
  espelho. Sem conexão utilizável a mudança vale e a nota fica só no histórico.
- **Webhook e sync.** Nota privada vinda do Chatwoot (criada aqui ou por um
  atendente lá) não entra no espelho de mensagens nem abre caso.
- **Pessoa removida.** Apagada (`auth.users`): o responsável vira `null`. Fora
  da organização (`membros_organizacao`): a leitura não a mostra como dona e
  responder assume a conversa. Ninguém herda; a próxima pessoa que responder ou
  assumir passa a ser a dona.
- **Trilha.** `chatwoot.control_changed` (ação, de, para, versão, contagens,
  `transferencia`; sem o texto da nota) e `chatwoot.send_invalidated` por
  resposta cancelada. O histórico guarda `responsavel_anterior`.

## 3. Política de transferência (decisão pendente da proprietária)

Hoje, quem tem `organization:access` assume a conversa de outra pessoa. Esse
contrato foi **mantido**, porque o Atlas não define a regra: a arquitetura lista
"assumir" como capacidade própria, mas não existe essa capacidade no catálogo de
permissões, e nada diz se transferir atendimento humano exige mais do que
assumir conversa livre.

O que mudou para impedir transferência acidental e deixá-la rastreável:

- a tela pede confirmação ("Transferir para mim") quando a conversa está com
  outro atendente ativo;
- o histórico grava `responsavel_anterior`, e a auditoria grava `transferencia: true`.

Decisões para a proprietária:

1. Transferir atendimento de outra pessoa exige uma capacidade específica (por
   exemplo `atendimento:transferir`) ou fica com `organization:access`?
2. A pessoa que perdeu a conversa deve ser avisada?
3. Quem pode devolver à automação, quando ela existir (`organization:manage` hoje)?
4. Uma pessoa pode liberar a própria conversa (`HUMAN` → `HUMAN_REQUIRED`) sem
   automação? Hoje não há essa transição.

## 4. Implantação da migration 91

### Ambientes

| Nome | O que é | Estado medido |
|---|---|---|
| Supabase Staging (`etqjq…`) | banco do app publicado | ledger com 93 registros, última migration 90 |
| Vercel Production | `staging.orbita.mkautobots.site`, usa o Supabase Staging; **todo merge na `main` publica aqui** | `main` `3d62493` |
| Supabase Production | projeto futuro, vazio | sem cadeia |
| Workers (notebook) | containers `orbita-workers-*` | rodando em modo desligado (`worker_desligado` no log) |

### Matriz de compatibilidade

| Banco \ App | App anterior (`main` `3d62493`) | App deste PR |
|---|---|---|
| **Sem a 91** | funciona | **Não pode acontecer.** `GET/POST /api/chatwoot/controle` respondem 503 (RPCs ausentes), a listagem de envios (`GET /api/chatwoot/send`) falha porque lê `privada`/`invalidado_em`, e o worker não reivindica (protocolo 2 ausente; fechado) |
| **Com a 91** | Compatível, com dois efeitos: (1) a rota antiga responde 503 quando o banco devolve `outro_responsavel` (só com dois atendentes na mesma conversa); (2) o webhook antigo ainda espelha nota privada vinda do Chatwoot. O worker antigo falha fechado ao reivindicar (assinatura removida) | funciona |

Como o merge publica o app novo na hora, **a 91 precisa estar no Supabase
Staging antes do merge**. O merge é o passo que fecha a janela.

### Ordem exata (cada passo depende de autorização explícita)

1. **Conferir o alvo, só leitura:** `npm run db:remoto:status` contra o Staging
   deve mostrar 93 aplicadas, a 91 (ordem 94) pendente e nada mais pendente.
2. **Confirmar workers desligados:** nos containers do notebook, o log mostra
   `chatwoot.envio.worker_desligado` e `chatwoot.inbox.worker_desligado`; nenhuma
   credencial real configurada.
3. **Aplicar a 91 no Staging** (`npm run db:remoto:aplicar`, com aprovação do
   alvo, do SQL e do rollback). Impacto de trava: `lock_timeout = 5s`. O
   `ADD COLUMN` com default constante em `chatwoot_envios` só mexe no catálogo.
   O `CHECK` novo varre `chatwoot_envios`, que é pequena. Se a trava não vier em
   5 s, a migration falha inteira e nada muda.
4. **Validar, só leitura:** ledger com 94; funções `ler_`/`alterar_controle_atendimento_chatwoot`
   e `iniciar_envio_chatwoot` presentes; claim de 4 argumentos ausente;
   `has_function_privilege('authenticated', …)` falso. A autoverificação no fim
   da migration já aborta se a superfície estiver exposta.
5. **Janela entre 3 e 6:** é a combinação "banco novo + app antigo" acima. Ela
   dura até o merge, e o único efeito visível é o 503 com dois atendentes na
   mesma conversa. Não há indisponibilidade do cockpit.
6. **Merge da #141** (autorização separada): a Vercel publica o app novo.
   Verificar em `staging.orbita…`: a barra "Atendimento" lê o controle, conversa
   em `AI` aparece como "Sem atendente", e a listagem de envios carrega.
7. **Workers continuam desligados.** Ligar o worker de envio é outra
   autorização, com corte de backlog (`p_criados_desde`) e credencial real.
8. **Supabase Production** recebe a cadeia inteira (01–91) quando for criado,
   antes de qualquer app apontar para ele.

### Rollback

- **App:** reimplantar o deployment anterior na Vercel. Com a 91 já aplicada,
  cai na combinação compatível "banco novo + app antigo".
- **Banco:** forward-only. Não se reverte a 91. Um defeito nela é corrigido por
  uma migration nova (92). Nunca recriar o claim antigo, porque isso reabriria o
  despacho sem conferir a versão.
- **Abortar antes do merge:** se o passo 3 falhar, nada mudou (transação única).
  Se o passo 4 mostrar algo errado, não fazer o merge e abrir correção.

### Antes de conectar um Chatwoot real

- Worker de envio desligado até a autorização, com corte de backlog definido.
- `npm run test:chatwoot` verde contra o Chatwoot CE local na versão que será usada.
- Diagnóstico de notas já espelhadas (seção 5) executado com autorização.
- Chatwoot local **nunca** exposto publicamente; a Vercel não fala com o
  `localhost` do notebook.
- Credenciais reais só no fim (ticket 25), separadas por ambiente.

## 5. Notas privadas espelhadas antes desta correção

Antes deste PR, nota privada vinda do Chatwoot entrava em `chatwoot_messages`
como mensagem comum, tanto pelo webhook quanto pelo sync. O código novo para de
espelhar, mas **não apaga** o que já entrou.

- Pelo **webhook**, a nota é identificável: o payload bruto fica na inbox com
  `private: true`.
- Pelo **sync**, não há payload guardado. Identificar exige reler a conversa no
  Chatwoot.

Diagnóstico **somente leitura**, a executar no Staging apenas com autorização:

```sql
select m.organizacao_id, count(*)::int as notas_espelhadas,
       count(distinct c.id)::int as casos_abertos_na_mesma_conversa
  from public.chatwoot_messages m
  join public.inbox_eventos_chatwoot e
    on e.organizacao_id = m.organizacao_id and e.conexao_id = m.conexao_id
   and e.payload ->> 'id' = m.id_externo
  left join public.sac_cases c on c.organizacao_id = m.organizacao_id and c.conversa_id_local = m.conversa_id_local
 where e.payload ->> 'private' = 'true'
 group by m.organizacao_id;
```

A consulta foi validada no laboratório (sem linhas). Remover o que ela
encontrar é uma alteração de dados com plano próprio; não faz parte deste PR.

## 6. Recuperação

- Forward-only. Para pausar a automação de uma conversa: `exigir_humano` ou
  `assumir`. Atendimento humano continua com o worker de envio ligado ou não.
- Uma resposta invalidada **não saiu**: o texto pode ser recuperado na tela e
  enviado de novo por quem é o dono.
- Nunca reabrir `dead_letter` de invalidação nem repetir um `unknown` como recuperação.

## 7. Verificação

```bash
npx vitest run src/services/chatwoot src/app/api/chatwoot src/components/mensageria
```

```bash
npm run test:db
```

```bash
npm run test:chatwoot
```
