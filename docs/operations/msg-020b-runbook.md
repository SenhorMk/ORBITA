# Chatwoot na VM do staging (MSG-020B)

Fatia do MSG-020: hospedar o Chatwoot CE na mesma VM Oracle Always Free dos workers
(decisão D5, 06/11/2026), com endereço público em HTTPS, para o staging ter uma conexão
Chatwoot real. Isso destrava o gate 4 do MSG-008.

**Dados.** Esta instância recebe só dados sintéticos. Mensagem de cliente real continua
bloqueada pelo MSG-021, e o banco do Chatwoot passa a guardar dado pessoal no dia em que
isso mudar.

**Produção.** O invariante do MSG-020 vale aqui: VM gratuita serve para staging, não para
produção.

## 1. O que roda

| Peça | Onde |
|---|---|
| Composição | `infra/chatwoot-vm/docker-compose.yml`: caddy, rails, sidekiq, postgres, redis |
| HTTPS | `infra/chatwoot-vm/Caddyfile`, certificado Let's Encrypt automático |
| Segredos | `infra/chatwoot-vm/.env` no host (fora do Git, `chmod 600`); modelo em `.env.example` |
| Backup | `infra/chatwoot-vm/backup.sh` (dump do Postgres + anexos) |
| Prova de restore | `infra/chatwoot-vm/restore-check.sh` (Postgres descartável) |

Imagens e digests são os do laboratório do MSG-001. Todas têm amd64 e arm64. Subir de
versão exige repetir `npm run test:chatwoot` antes.

Em relação ao laboratório:

- Só o Caddy publica porta (80 e 443). Rails, Postgres e Redis ficam na rede interna.
- Sem `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`: o webhook só sai para endereço público.
- `restart: unless-stopped`, log rotacionado (5 × 10 MB por serviço), Redis com AOF.
- Cabeçalhos HSTS e `nosniff`; `Server` removido. HTTP redireciona para HTTPS (308).

## 2. A VM (feito pela proprietária)

1. **Uma VM para o Chatwoot e os workers:** VM.Standard.A1.Flex, Ubuntu 24.04,
   **2 OCPU e 12 GB**. Isso substitui o tamanho de 1 OCPU e 6 GB do runbook MSG-020A,
   que só considerava os workers. Confira no console o limite gratuito da conta.
2. **IP público reservado**, para o DNS não quebrar se a instância for recriada.
3. **Regras de entrada** na Security List (ou NSG) da sub-rede: TCP 22 só do seu IP,
   TCP 80 e 443 de `0.0.0.0/0`. A porta 80 precisa ficar aberta para o Let's Encrypt.
4. **Firewall do Ubuntu.** As imagens Ubuntu da Oracle vêm com `iptables` bloqueando
   tudo além do SSH, mesmo com a Security List aberta. Libere 80 e 443 antes da regra
   de REJECT e salve:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
```

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
```

```bash
sudo netfilter-persistent save
```

5. **DNS:** registro A do domínio escolhido (ex.: `chat.<domínio>`) apontando para o IP
   reservado. Espere ele resolver antes de subir o Caddy.
6. **Recolhimento por ociosidade.** A Oracle pode recolher instância Always Free
   ociosa. Confira a regra atual no console; converter a conta para pagamento por uso
   evita o recolhimento sem cobrar o que está dentro da cota.

## 3. Instalar

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 openssl
```

```bash
sudo usermod -aG docker "$USER" && sudo systemctl enable docker
```

Copie só a pasta `infra/chatwoot-vm` para o host (por `scp` ou clone do repositório) e,
dentro dela:

```bash
cp .env.example .env && chmod 600 .env
```

Preencha o `.env`: domínio, e-mail do Let's Encrypt e os três segredos com
`openssl rand -hex 32`. Os segredos são desta instância; não reutilize os do laboratório.

Suba na ordem: bancos, preparação do banco do Chatwoot, resto.

```bash
docker compose up -d --wait postgres redis
```

```bash
docker compose run --rm --no-deps rails bundle exec rails db:chatwoot_prepare
```

```bash
docker compose up -d
```

Conferir:

```bash
curl -s https://chat.<domínio>/api
```

Esperado: `"version":"4.19.1"`, `"queue_services":"ok"`, `"data_services":"ok"`.

**Logo em seguida**, abra `https://chat.<domínio>` e crie o administrador na tela de
instalação. Até isso ser feito, qualquer pessoa que chegar no endereço cria o primeiro
administrador. O cadastro público fica desligado (`ENABLE_ACCOUNT_SIGNUP=false`).

## 4. Backup

```bash
./backup.sh
```

Gera em `BACKUP_DIR` o dump do Postgres (`chatwoot-<carimbo>.dump`, formato custom) e os
anexos (`storage-<carimbo>.tar.gz`), apaga os mais velhos que `BACKUP_RETENTION_DAYS` e,
se `BACKUP_RCLONE_REMOTE` estiver preenchido, copia para fora da VM com `rclone`. Sem o
remoto, o script avisa: cópia na própria VM some junto com ela e não vale como backup.

Agendar todo dia às 03:00 UTC (`crontab -e`):

```text
0 3 * * * /caminho/infra/chatwoot-vm/backup.sh >> /var/log/chatwoot-backup.log 2>&1
```

O destino externo (Object Storage da Oracle ou outro, configurado com `rclone config`)
é decisão da proprietária, junto com a D5.

**Prova de restore**, uma vez por mês e depois de cada atualização:

```bash
./restore-check.sh
```

Restaura o dump mais recente num Postgres descartável, sem tocar na instância, e
imprime `contas=… conversas=… mensagens=…`. O container é removido no fim.

## 5. Ligar ao staging

1. No Chatwoot: conta, caixa de entrada e token de acesso de um agente.
2. No ORBITA do staging: a conexão Chatwoot com a URL `https://chat.<domínio>`, o token
   e o segredo do webhook. Isso cria a conexão que o gate 4 do MSG-008 exige.
3. No Chatwoot: webhook da caixa apontando para o endpoint do staging.
4. Workers: runbook MSG-020A, com `CHATWOOT_*` no `.env` dos workers. Os kill switches
   seguem desligados até a autorização do gate 4.

## 6. Atualizar o Chatwoot

1. `npm run test:chatwoot` verde com a nova versão no laboratório.
2. Na VM: `./backup.sh`, trocar a imagem e o digest no compose, e:

```bash
docker compose run --rm --no-deps rails bundle exec rails db:chatwoot_prepare
```

```bash
docker compose up -d
```

3. `./restore-check.sh` com o backup da véspera da atualização.

## 7. Rollback e parada

- **Parar tudo:** `docker compose stop`. Os volumes ficam; `docker compose up -d` volta.
- **Voltar de versão:** restaurar o backup anterior à atualização, já que a migração do
  Chatwoot não volta sozinha. Restore na instância: parar rails e sidekiq, `pg_restore
  --clean` com o dump, subir de novo.
- **Desligar a conexão no ORBITA** antes de qualquer restore, para os workers não
  conversarem com um Chatwoot no meio da troca.
- Nunca `docker compose down -v` sem backup conferido: o `-v` apaga os volumes.

## 8. Limites desta fatia

- A VM não existe ainda; nada aqui foi rodado na Oracle nem em arm64.
- O destino externo do backup não foi escolhido.
- SMTP é opcional e não foi testado.
- Sem alerta de disco, de certificado ou de Chatwoot fora do ar. Isso vai com os alertas
  do restante do MSG-020.
