# Controle do atendimento (MSG-009) — migration 91_controle_atendimento_chatwoot.sql

Cada conversa tem **um único dono lógico**: a automação (`AI`), ninguém até um
atendente assumir (`HUMAN_REQUIRED`) ou um atendente (`HUMAN`). Toda mudança
incrementa `control_version`, invalida no banco as respostas ainda na fila e
informa as que já estão em voo. Arquivo na ordem 94 do ledger, sobre a `main`
`3d62493` (MSG-008 integrado).

Nenhuma IA responde hoje. `AI` só registra que a automação **pode** responder;
o envio de respostas pela automação chega com MSG-013/MSG-014 e já nasce
sujeito a esta versão.

## 1. Caminho

```text
cockpit: GET  /api/chatwoot/controle?conversaId=…  → { modo, responsavelId, souResponsavel, versao }
         POST /api/chatwoot/controle { conversaId, commandId, acao, versaoEsperada, nota? }
              alterar_controle_atendimento_chatwoot: CAS na versão, histórico, nota privada,
              invalidação da fila e auditoria, numa transação
         POST /api/chatwoot/send (MSG-008): responder conversa sem dono a assume;
              conversa de outra pessoa → 409 outro_responsavel
worker:  reivindicar_envios_chatwoot(…, p_protocolo = 2) → devolve `privada`
         → iniciar_envio_chatwoot: confere a versão sob trava compartilhada antes de in_flight
           (versão vencida → dead_letter sem chamar o Chatwoot)
         → mensagem: sendMessage (private: false) · nota: sendPrivateNote (private: true)
         → concluir_envio_chatwoot: nota confirmada não vira mensagem espelhada
```

| Peça | Onde |
|---|---|
| Controle e histórico | `chatwoot_conversa_controle`, `chatwoot_controle_historico` (só leitura para `service_role`) |
| Mudança | `alterar_controle_atendimento_chatwoot` (só `service_role`) |
| Início do despacho | `iniciar_envio_chatwoot` (substitui `iniciar_despacho_outbox` no worker de envio) |
| Rota | `src/app/api/chatwoot/controle/route.ts` |
| Serviço | `src/services/chatwoot/controleAtendimento.ts` |
| Tela | `src/components/mensageria/useControle.ts`, `BarraDoAtendimento` em `MensageriaDesktop.tsx` |

## 2. Regras

| Ação | De | Para | Quem | Exige |
|---|---|---|---|---|
| `assumir` | qualquer estado, salvo já ser seu | `HUMAN`, você | `organization:access` | versão vigente; nota opcional |
| `devolver` | `HUMAN` seu | `AI` | `organization:manage` (rota e banco) | versão vigente; **resumo obrigatório** |
| `exigir_humano` | `AI` | `HUMAN_REQUIRED` | `organization:access` | versão vigente; nota opcional |
| responder (MSG-008) | `AI`, `HUMAN_REQUIRED` ou `HUMAN` sem dono | `HUMAN`, você | `organization:access` | — (assume na mesma transação) |

| Resultado | HTTP | Significado |
|---|---|---|
| `aplicado` / `existente` | 200 | mudou; `existente` é a repetição do mesmo `commandId` com os mesmos dados |
| `conflito_versao` | 409 | outra aba ou pessoa mudou antes; a resposta traz o controle atual |
| `transicao_invalida` | 409 | a ação não vale para o estado atual |
| `conflito_comando` | 409 | mesmo `commandId` com outros dados |
| `sem_capacidade` / `sem_vinculo` | 403 | sem permissão / fora da organização |
| `conversa_inexistente` | 404 | conversa de outra organização ou inexistente |
| erro do banco ou resposta fora do contrato | 503 | nada mudou |

- **Fila.** A mudança marca `dead_letter` (`last_error` fixo, categoria
  `permanent`) e `chatwoot_envios.invalidado_em` nas respostas `pending` com
  versão anterior. As já reivindicadas são invalidadas em `iniciar_envio_chatwoot`,
  que espera a trava do controle. A saúde da conexão não muda.
- **Em voo.** Uma resposta `in_flight` não é desfeita: a mudança devolve
  `em_voo` e a tela avisa que ela pode chegar à cliente. Segue o protocolo da
  outbox (recibo, `unknown`, reaper).
- **Nota privada.** Cada mudança registra uma intenção `privada` (`message.note`)
  com texto fixo + nota/resumo, despachada com `private: true`. Ela não é
  invalidada por mudanças posteriores, só é confirmada se o recibo disser
  `private: true` (senão `unknown`, para inspeção) e nunca vira mensagem no
  espelho. Sem conexão utilizável a mudança vale e a nota fica só no histórico.
- **Webhook e sync.** Nota privada vinda do Chatwoot (criada aqui ou por um
  atendente lá) não entra no espelho de mensagens nem abre caso.
- **Pessoa removida.** O responsável vira `null`; ninguém herda. A próxima
  pessoa que responder ou assumir passa a ser a dona.
- **Trilha.** `chatwoot.control_changed` (ação, de, para, versão, contagens; sem
  o texto da nota) e `chatwoot.send_invalidated` por resposta cancelada.

## 3. Compatibilidade e implantação

| Banco \ App | App anterior (main `3d62493`) | App deste PR |
|---|---|---|
| Sem a 91 | funciona | **não implantar**: `/api/chatwoot/controle` e o claim de protocolo 2 falham |
| Com a 91 | rota de envio responde 503 se o banco devolver `outro_responsavel`; o worker antigo **falha ao reivindicar** (assinatura removida) — fechado, nada sai | funciona |

Ordem: aplicar a 91 → implantar o app → só então, com autorização, ligar o
worker de envio. Envios já registrados ficam com `controle_versao = 0` e saem
normalmente enquanto ninguém mudar o controle daquela conversa; a primeira
mudança os invalida.

## 4. Recuperação

- Forward-only. Para pausar a automação de uma conversa: `exigir_humano` ou
  `assumir`. Atendimento humano continua com o worker de envio ligado ou não.
- Uma resposta invalidada **não saiu**: o texto pode ser recuperado na tela e
  enviado de novo por quem é o dono.
- Nunca reabrir `dead_letter` de invalidação nem repetir um `unknown` como recuperação.

## 5. Verificação

```bash
npx vitest run src/services/chatwoot src/app/api/chatwoot src/components/mensageria
```

```bash
npm run test:db
```

```bash
npm run test:chatwoot
```
