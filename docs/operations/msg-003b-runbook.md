# APIs, UI, Realtime e envio do Chatwoot pelo UUID local (MSG-003B)

Segunda metade do migrate da identidade Chatwoot. Depois do MSG-003A (webhook e
sync), a jornada do lojista — abrir a conversa, acompanhar em tempo real,
responder e resolver — passa a referenciar só o UUID local. O id do Chatwoot
fica no servidor: adapter e resolver. **Sem SQL novo**: os índices de leitura
por UUID (`idx_chatwoot_messages_conversa_local`) e a FK composta do contato já
vêm da migration 85.

## 1. Contrato

| Rota / peça | Antes | Agora |
|---|---|---|
| `POST /api/chatwoot/send` | `{ conversationId: number, content }`; resposta com a mensagem do Chatwoot (id remoto) | `{ conversaId: uuid, content }` (Zod). Resposta `{ success, message: { id_local, conversa_id_local, content, message_type, sender_name, created_at } }`, sem id remoto |
| `POST /api/chatwoot/status` | `{ conversationId: number, status }` | `{ conversaId: uuid, status }` (Zod) |
| Espelho do navegador | `select('*')`, contato pela FK legada, histórico e Realtime por `conversation_id` | colunas explícitas sem id remoto, contato pela FK composta `fk_chatwoot_conversations_contato_local`, histórico e Realtime por `conversa_id_local` |
| Tipos `ChatwootConversation/Message/Contact` (`src/types`) | `id: number`, `contact_id`, `conversation_id` | `id_local`, `contato_id_local`, `conversa_id_local` |

Sem fallback por id remoto: um corpo com `conversationId` recebe 400.

Resolução no servidor (`resolverPorIdLocal`): a organização vem da sessão
verificada; a conexão é a da própria conversa nessa organização; o id remoto
sai do resolver nessa conexão; o adapter é aberto para essa conexão
(`ChatwootAdapter.forScope(scope, conexaoId)`), nunca outra.

| Situação | Envio | Status |
|---|---|---|
| UUID desta organização, conexão provada | 200, envia pela conexão da conversa | 200 |
| UUID de outra organização, adulterado ou inexistente | 404 `IdentidadeNaoEncontrada`, sem outbox nem Chatwoot | 404 |
| Conversa legada sem conexão provada (quarentena) | 422 `ConexaoNaoComprovada` | 422 |
| Banco indisponível | 503 | 503 |
| Conexão desligada (PRE-008) | outbox `failed`, 409, sem Chatwoot | 409 |
| Sem sessão / sem vínculo | 401 / 403, nada acontece | idem |

422 e não 409 para identidade: na tela, 409 quer dizer "integração indisponível".

## 2. Realtime e troca de organização

A assinatura de mensagens filtra `conversa_id_local=eq.<uuid>` no servidor e,
no cliente, descarta evento cujo `organizacao_id` ou `conversa_id_local` não
seja o da conversa aberta. Um evento da conversa 50 de outra conexão nunca casa
o filtro (o UUID é único). O evento é reduzido aos campos do navegador antes de
chegar à tela. A chave de estado da conversa é `organização:versão#uuid`:
trocar a organização com a aba aberta invalida histórico, rascunho e envios em
curso no mesmo render (comportamento já existente, agora com o UUID).

## 3. Implantação e rollback

- Depende da migration 85 aplicada (as colunas e a FK composta) e do código do
  MSG-003A. Mesma ordem do runbook do MSG-003A: 85 → código.
- API e tela mudam juntas no mesmo deploy. Uma aba com o bundle antigo aberta
  durante o deploy manda `conversationId` e recebe 400 até recarregar; nenhum
  envio é feito nesse caso (falha visível, nada duplicado).
- Rollback: reverter o código para o MSG-003A. Nada no banco muda. Mensagens em
  voo: a outbox guarda a tentativa (`conversaIdLocal`, `conexaoId`); não repetir
  envio de resultado desconhecido.

## 4. Efeitos externos

O envio continua inline, como antes (o consumidor real é o MSG-008). O que
muda é só como a conversa é identificada. A matriz de 17 casos do envio não é
reaberta aqui: timeout ou 2xx inválido seguem marcando a outbox como falha sem
retry automático, e a tela segue dizendo "não confirmada". O caso novo, banco
local falhando depois do envio aceito, mantém o comportamento anterior (500 com
a outbox `sent`) e fica para o MSG-008.

## 5. Evidência

- `src/app/api/chatwoot/send/uuid-local.test.ts`: envio pela conexão da
  conversa com id remoto resolvido no servidor; duas instalações na mesma
  organização com a conversa 50; id remoto como referência → 400; UUID de outra
  organização ou adulterado → 404 sem efeito; quarentena → 422; sem vínculo →
  403; status isolado por conexão.
- `src/app/api/chatwoot/send/desligada.test.ts`: o PRE-008 continua valendo com
  o store real sobre o cliente dublado.
- `src/components/mensageria/espelhoDaMensageria.test.ts`: colunas sem id
  remoto, FK composta, filtro Realtime por UUID, evento de outra organização ou
  conversa descartado.
- `src/components/mensageria/MensageriaDesktop.test.tsx`: corpo do envio e do
  status só com UUID; resposta sem `id_local` não confirma; os testes de troca
  de organização com leitura em voo continuam verdes.
- `src/lib/chavesGlobaisChatwoot.test.ts`: fora do store ninguém grava nos
  espelhos; envio e status não nomeiam as tabelas; o navegador não lê por id
  remoto.

Limitações: não há spec E2E da mensageria no repositório e as specs rodam
contra o ambiente publicado; a jornada abrir/responder foi provada por testes
de componente e de rota com fakes do Chatwoot. Nenhuma chamada real.
