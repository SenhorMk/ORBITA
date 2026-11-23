# WhatsApp do Portal do Haux

Infraestrutura aditiva para Evolution API 2.3.7 (Baileys), com Postgres 16 e
Redis 7 próprios. As três imagens devem ser fixadas por digest no ambiente
protegido. Não utiliza o banco ou o Redis do Chatwoot.

## Operação

O arquivo `compose.env.example` documenta somente caminhos e referências de
imagens. Senhas, chave Evolution, QR e sessões permanecem fora do Git, no
diretório protegido do operador. Nunca executar `docker compose config` sem
`--quiet` em registros compartilhados: a saída pode incluir segredos.

```powershell
docker compose -p orbita-evolution --env-file C:/Users/OWNER/orbita-infra/protegido/evolution/compose.env -f infra/evolution/compose.yml config --quiet
docker compose -p orbita-evolution --env-file C:/Users/OWNER/orbita-infra/protegido/evolution/compose.env -f infra/evolution/compose.yml up -d
```

A API administrativa é publicada exclusivamente em `127.0.0.1:18080`.
O Chatwoot alcança a API pelo alias `orbita-evolution` na rede existente.
Os aliases privados `haux-evolution-db` e `haux-evolution-cache` evitam colisões
com os serviços chamados `postgres` e `redis` no outro projeto.

A sessão usa os volumes `instances` e Postgres; o Redis usa AOF. Não executar
`down -v`, logout ou exclusão da instância para reiniciar o serviço.

O callback nativo do Chatwoot não possui autenticação própria na Evolution.
Por isso, o proxy público aceita apenas POST no caminho exato com prefixo
aleatório protegido. Nenhuma rota administrativa é exposta. O segredo desse
caminho deve ser tratado como credencial e não publicado em evidências.

## Configuração inicial

- Instância `WHATSAPP-BAILEYS`, `syncFullHistory=false`, grupos ignorados,
  leitura automática e presença permanente desativadas.
- Chatwoot conta existente, nova inbox API exclusiva; não alterar a inbox
  WebWidget Shopify nem criar outro webhook global para a mesma conta.
- `importContacts=false`, `importMessages=false`, `daysLimitImportMessages=0`,
  `CHATWOOT_BOT_CONTACT=false`; sem contato administrativo ou envio inicial.
- Autoatribuição e saudação automática da nova inbox desativadas.
- `conversationPending=false` enquanto a IA da inbox estiver desabilitada:
  novas conversas precisam aparecer no filtro **Abertos** do cockpit. Não
  colocar a inbox em `pending` antes de comprovar o runtime autorizado.
- `groupsIgnore=true` confirmado pela API; webhook direto da Evolution
  desabilitado, sem assinatura de eventos de grupos.
- IA da nova inbox permanece desabilitada até aprovação e prova integrada.

O worker mantém o modo de uma inbox quando `HAUX_BOT_INBOXES` não é definido.
Após a migration de ordem 103 (`database/100_runtime_ai_por_inbox.sql`),
`HAUX_BOT_INBOXES=1,2` permite ao mesmo motor validar cada canal e renovar
sua prontidão separadamente. Uma inbox indisponível não renova a própria
prontidão. Os registros de runtime e consumo passam a incluir a inbox;
takeover, fencing, deduplicação e a outbox existentes continuam sendo usados.

A migration não cria runtime WhatsApp nem libera clientes. Ativar a segunda
inbox exige configuração explícita, corte para mensagens novas,
`clientes_liberados=false`, conversa de teste indicada pelo operador e quota
restrita. A configuração Shopify deve ser comparada antes e depois da troca.
O desligamento global existente continua bloqueando ambas as inboxes.

A ordem 104 (`database/101_lista_conversas_teste.sql`) mantém a coluna privada
`conversa_teste_externa`, passando a aceitar IDs separados por vírgula.
O filtro compara IDs completos; `10,11` não autoriza `12` ou `110`.
No staging, somente as conversas 10 e 11 estão incluídas, com liberação geral
desligada e limite compartilhado de três gerações por dia. Uma conversa
assumida por humano precisa de devolução explícita antes de a IA retomar;
a mensagem que comprova a retomada deve chegar após essa devolução.

Em 20/11/2026 a ordem 103 foi autorizada e aplicada somente no staging,
com validação de ledger, RLS, grants e preservação da configuração Shopify.
A configuração comercial do WhatsApp permanece desligada até a prova real.

## Gates reais pendentes

1. Confirmar estado conectado e persistência reiniciando somente a Evolution.
3. Receber mensagem de um contato de teste e responder pelo Chatwoot.
4. Comprovar ingestão e resposta humana pelo cockpit ORBITA.
5. Configurar somente a conversa de teste autorizada no runtime WhatsApp.
6. Comprovar Groq, takeover, devolução, desligamento e deduplicação no WhatsApp.

QR gerado ou callback HTTP 200 não comprovam entrega de mensagem. Somente
recibos dos serviços e confirmação no telefone constituem evidência final.
