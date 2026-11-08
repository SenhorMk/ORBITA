# Infraestrutura local no notebook Windows (MSG-020C)

**Decisão D5 revisada em 07/11/2026 e 08/11/2026.** A Oracle Cloud Always Free em São Paulo recusou a
`VM.Standard.A1.Flex` por falta de capacidade, mesmo com memória reduzida. O host passa a
ser, **temporariamente**, o notebook Windows da proprietária, e **só ele**: não há segundo
notebook, Tailscale, SSH, RDP nem acesso remoto (decisão de 08/11/2026). A administração é
local: navegador, terminal, Docker Desktop e os scripts abaixo. **Não é VM de produção** e não
oferece disponibilidade 24/7. O banco continua no Supabase e a aplicação na Vercel. A
Oracle, ou outra VPS Linux, fica como alternativa futura, com os runbooks MSG-020A e
MSG-020B valendo como estão.

Custo de hospedagem: zero. Dados: só sintéticos. Marco A: NO-GO. Workers reais: desligados.

## 1. Os dois modos

| | Modo A, laboratório | Modo B, host preparado |
|---|---|---|
| O quê | Chatwoot CE 4.19.1 (`infra/chatwoot-vm`) | Workers inbox e envio (`infra/worker`) |
| Rede | Só `127.0.0.1:8080/8443`; Postgres e Redis sem porta | **Nenhuma** (`network_mode: none`) |
| Dados | Sintéticos | Nenhum |
| Credenciais | Geradas localmente | Placeholders; nenhuma real |
| Estado | Rodando | De pé, kill switches `false`, parados |

As provas dos workers contra o banco usam o laboratório descartável (`npm run test:worker`,
PostgREST e Postgres efêmeros), não o Modo B. **Laboratório local não é staging.**

## 2. Onde fica cada coisa

| Peça | Caminho |
|---|---|
| Configuração e segredos | `%USERPROFILE%\orbita-infra\chatwoot.env` e `workers.env` (fora do Git e do OneDrive) |
| Backups | `%USERPROFILE%\orbita-infra\backups` |
| Script de operação | `scripts/infra-local.mjs` e o atalho `infra/local/orbita-local.ps1` |
| Sobreposição do Modo B | `infra/local/workers.modo-b.yml` |
| Projetos Docker | `orbita-chatwoot` e `orbita-workers` (volumes nomeados persistentes) |

## 3. Operar

Da raiz do checkout com esta branch, `node scripts/infra-local.mjs <comando>`. De qualquer
pasta, pelo PowerShell:

```powershell
& "$env:USERPROFILEOneDriveDocumentosMKORBITA-msg-020cinfralocalorbita-local.ps1" verificar
```

Comandos:

```bash
node scripts/infra-local.mjs preparar
```

Cria a configuração só se ela não existir. Nunca sobrescreve segredo nem backup.

```bash
node scripts/infra-local.mjs iniciar
```

Abre o Docker Desktop se ele não estiver rodando (espera até 3 min). Se tudo já está no ar,
não faz nada. Senão sobe Postgres e Redis, prepara o banco do Chatwoot (idempotente), sobe o
resto e os workers no Modo B, com a imagem existente.

```bash
node scripts/infra-local.mjs verificar
```

Confere a API do Chatwoot (com prazo de 10 s por chamada), as portas presas a
`127.0.0.1`, os 5 containers do Chatwoot de pé e sem reinício inesperado e, para cada
worker: de pé, sem reinício, sem rede, kill switch `false`, sem corte de backlog e com o log
`worker_desligado`. Imprime CPU, memória e disco do Docker. Sai com 1 e diz que o
laboratório está com problema se alguma checagem falhar, ou indisponível se o Docker não
responder.

```bash
node scripts/infra-local.mjs parar
```

Para os containers. Os volumes ficam.

```bash
node scripts/infra-local.mjs atualizar
```

Reconstrói a imagem dos workers com o código do checkout, recria os containers (zera a
contagem de reinícios) e reaplica as migrações do Chatwoot.

Na primeira subida, abra `https://localhost:8443` e crie o administrador. O navegador
avisa sobre o certificado interno do Caddy para `localhost`, e isso é esperado.

## 4. Backup e restore do laboratório

```bash
node scripts/infra-local.mjs backup
```

```bash
node scripts/infra-local.mjs restore
```

`backup` gera o dump do Postgres e o arquivo dos anexos em `orbita-infra\backups`.
`restore` restaura o dump mais recente num Postgres descartável e imprime
`contas=… conversas=… mensagens=…`. Se o Postgres descartável não ficar pronto em
`RESTORE_CHECK_TIMEOUT_SECONDS` (120 s), sai com erro; o container descartável é removido em
qualquer saída, inclusive Ctrl+C. **Backup só vale depois de um restore que funcionou.**

- **Retenção:** `BACKUP_RETENTION_DAYS=0`, ou seja, nada é apagado automaticamente.
  Apagar backup antigo é decisão da proprietária.
- **Limite:** backup guardado só no notebook não protege contra perda, roubo ou defeito do
  equipamento. Para dado sintético isso basta. Para dado real, não.
- Nunca copiar dados do staging ou da produção para cá.

## 5. Acesso

Só por este notebook: `https://localhost:8443` no navegador. O Caddy publica apenas em
`127.0.0.1`, então nada responde pela rede local nem pela internet. Postgres, Redis, Docker
Engine e workers não têm porta. Não há Tailscale, SSH, RDP, túnel ou porta no roteador, e o
`verificar` reprova se alguma porta sair de `127.0.0.1`.

## 6. Energia, tampa e reinício

Estado medido em 07–08/11/2026:

- Suspensão: **nunca**, na tomada e na bateria.
- Hibernação: nunca na tomada.
- Tampa: configuração oculta no esquema "Equilibrado". O padrão do Windows com Modern
  Standby (S0) é **suspender ao fechar a tampa**, e com isso os containers param.
- Docker Desktop abre no login: `AutoStart` ligado nas configurações do Docker Desktop e
  chave `Run` do usuário.
- Containers com `restart: unless-stopped`.

Para o notebook seguir servindo **na tomada** com a tampa fechada, sem mudar o
comportamento na bateria (rodar como o próprio usuário):

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0; powercfg /setactive SCHEME_CURRENT
```

Desfazer, voltando a suspender na tomada:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1; powercfg /setactive SCHEME_CURRENT
```

**Modern Standby, medido.** Mesmo com a suspensão em "nunca", o Windows entrou em espera
moderna várias vezes na madrugada de 08/11 (Kernel-Power 506/507, provavelmente tela
desligada ou tampa fechada). Na espera, a VM do Docker congela e os containers param de
rodar, sem perder estado; ao acordar, voltam do ponto em que estavam. Antes da correção do
MSG-020C, o vigia via o salto do relógio e reiniciava o worker desligado. Agora ele reconhece
o congelamento e só re-arma o prazo. Durante a espera o Chatwoot não responde.

**Implicações:** tampa fechada esquenta mais e consome energia continuamente. Use em
superfície dura e ventilada. Bateria a 100% o tempo todo envelhece a célula. Se o BIOS da
Lenovo oferecer "Conservation Mode" (Lenovo Vantage), ligue para limitar a carga.

**Depois de um reboot**, os containers só voltam quando alguém **fizer login** no Windows,
porque o Docker Desktop é um aplicativo do usuário. Os workers continuam desligados: o
estado vem do `workers.env`, e nada no reinício liga um kill switch.

## 7. Limites para 24/7

O notebook não oferece disponibilidade 24/7:

- desligado, suspenso, sem energia, sem internet ou sem login, tudo para;
- atualizações do Windows reiniciam a máquina;
- fechar a tampa na bateria suspende, e a espera moderna pode ocorrer mesmo na tomada;
- o Wi-Fi doméstico tem IP e qualidade variáveis;
- não há redundância de disco nem backup fora do equipamento.

Para staging com SLA ou produção, migrar para uma VPS Linux com os runbooks MSG-020A e
MSG-020B: mesmo compose, `CHATWOOT_BIND` padrão, domínio real e backup externo.

## 8. Critérios para conectar ao staging real (não executados)

Cada item é um gate com autorização própria:

1. Revisão e merge de #138, #139 e desta fatia na `main`.
2. Chatwoot alcançável pelo staging na Vercel. Isso exige endereço público com HTTPS, que
   o notebook não tem sem túnel público, e túnel público está fora desta etapa.
3. Conexão Chatwoot criada no ORBITA do staging (gate 4 do MSG-008).
4. `workers.env` com as chaves do **staging** (nunca da produção), sem a sobreposição do
   Modo B, e kill switches ainda `false`.
5. Inventário do backlog e instante de corte autorizado antes de ligar qualquer worker.
6. Dados reais: só depois do MSG-021.

## 9. Recursos

Medição de 07–08/11/2026, Modo A e Modo B parados: cerca de 1,1 GB de RAM (rails cerca de
420 MB, sidekiq cerca de 500 MB, postgres cerca de 110 MB, workers cerca de 26 MB cada) e
CPU perto de 0%. A VM do Docker tem 8 GB, metade da RAM. O notebook tem 15,7 GB e
costuma ficar com pouca memória livre com navegador e IDE abertos.
