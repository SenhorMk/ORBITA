# Workers da mensageria em container (MSG-020A)

Fatia do MSG-020: empacotar e supervisionar os dois workers (inbox, MSG-006; envio,
MSG-008) para rodarem fora da máquina de desenvolvimento. Host escolhido pela
proprietária em 06/11/2026: **Oracle Cloud Always Free** (decisão D5). Alertas de
backlog e UNKNOWN, heartbeat no banco e reconciliação ficam para o restante do
MSG-020, depois do MSG-009.

Nada aqui liga o trabalho: os dois kill switches começam desligados, e ligar cada um
exige autorização própria e o corte do backlog.

## 1. O que roda

| Peça | Onde |
|---|---|
| Imagem | `infra/worker/Dockerfile` (Node 24 Alpine por digest; amd64 e arm64) |
| Processo | `scripts/worker-supervisionado.ts <inbox\|envio>`, compilado para `dist-worker/` |
| Supervisão | `src/services/worker/supervisao.ts` + `restart: unless-stopped` |
| Composição | `infra/worker/docker-compose.yml`, dois serviços: `inbox` e `envio` |
| Segredos | `infra/worker/.env` no host (fora do Git); modelo em `.env.example` |

**Supervisão.** Cada volta do laço bate no vigia. Sem batida por
`WORKER_WATCHDOG_SECONDS` (padrão 300), o processo registra `worker.travado`, sai
com código 1 e o Docker o reinicia; a lease que ele segurava vence e o reaper a
recupera. Com o kill switch desligado, o laço termina e o processo fica de pé, parado
(`chatwoot.*.worker_desligado`), em vez de entrar num laço de reinícios. No `SIGTERM`,
termina o evento em curso e sai com 0 (`worker.encerrado`); o compose dá 30 s.

**Container.** Sistema de arquivos só leitura, `/tmp` em memória, sem capacidades
Linux, `no-new-privileges`, usuário `node`, 256 MB de memória e log rotacionado.
Nenhuma porta publicada: o worker só fala com o Supabase e com o Chatwoot.

## 2. Provar localmente

```bash
npm run test:worker
```

Exige Docker. Constrói a imagem com o código atual e prova o container contra o
laboratório (PostgREST e Postgres reais): desligado fica de pé sem reinício e para
limpo; ligado consome uma entrega real da inbox e abre o caso; o de envio conversa
com o banco sem erro; com o banco pendurado, o vigia derruba o processo e o Docker o
reinicia. Não fala com nenhum provedor.

## 3. Preparar a VM na Oracle (feito pela proprietária)

1. Conta Oracle Cloud Always Free, na região mais próxima do projeto Supabase do
   ambiente. A proprietária escolhe a região; ela não muda depois.
2. Instância **VM.Standard.A1.Flex** (Ampere, arm64), Ubuntu 24.04, 1 OCPU e 6 GB
   bastam para os dois workers.
3. Sem regra de entrada além do SSH, e o SSH só por chave. O worker não recebe
   conexões.
4. A Oracle pode recolher instâncias Always Free ociosas. Os workers mantêm a CPU
   quase parada, então confira o aviso de recolhimento no console.

## 4. Instalar no host

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
```

```bash
sudo usermod -aG docker "$USER"
```

Entre de novo na sessão e clone o repositório numa pasta própria:

```bash
git clone https://github.com/SenhorMk/ORBITA.git orbita && cd orbita
```

```bash
cp infra/worker/.env.example infra/worker/.env && chmod 600 infra/worker/.env
```

Preencha o `.env` com as chaves do **ambiente alvo** (staging primeiro). Não copie o
`.env.local` da máquina de desenvolvimento.

```bash
docker compose -f infra/worker/docker-compose.yml up -d --build
```

```bash
docker compose -f infra/worker/docker-compose.yml logs --tail 20
```

Esperado: `chatwoot.inbox.worker_desligado` e `chatwoot.envio.worker_desligado`, com
os dois containers `running` e sem reinício.

Os containers voltam sozinhos depois de um reboot, se o serviço do Docker estiver
habilitado:

```bash
sudo systemctl enable docker
```

## 5. Atualizar

```bash
git pull --ff-only && docker compose -f infra/worker/docker-compose.yml up -d --build
```

Atualize os workers só depois de a migration correspondente estar no banco do
ambiente: banco primeiro, aplicação, worker por último.

## 6. Ligar um worker (gate próprio)

1. Inventário do backlog do ambiente (runbooks MSG-006 §backlog e MSG-008 §4).
2. No `.env`: `CHATWOOT_*_WORKER_ENABLED=true` e o `*_BACKLOG_DESDE` com o instante de
   corte em ISO UTC. Sem o corte, o processo recusa subir.
3. Recarregar o serviço:

```bash
docker compose -f infra/worker/docker-compose.yml up -d
```

**Parar o trabalho:** o kill switch volta para `false` e o comando acima é repetido. As
intenções e os eventos ficam na fila; nada se perde.

## 7. Limites desta fatia

- Sem heartbeat no banco nem alerta: um worker parado ou travado em laço de reinícios
  só aparece nos logs do host. Alertas de backlog e UNKNOWN são do MSG-020.
- A imagem leva todas as dependências de produção do app, inclusive Next e React:
  maior do que o necessário, sem efeito no comportamento.
- A chave `service_role` fica no host (ver o risco no runbook do MSG-008, §8).
- Dados reais continuam bloqueados pelo MSG-021; o Marco A segue NO-GO.
- A VM, a conta e a região não foram criadas nem testadas aqui: o `test:worker`
  prova a imagem num Docker local amd64, não na Ampere arm64.
