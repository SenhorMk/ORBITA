# Infraestrutura local no notebook Windows (MSG-020C)

**Decisão D5 revisada em 07/11/2026.** A Oracle Cloud Always Free em São Paulo recusou a
`VM.Standard.A1.Flex` por falta de capacidade, mesmo com memória reduzida. O host passa a
ser, **temporariamente**, o notebook Windows da proprietária. **Não é VM de produção** e não
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
| Script de operação | `scripts/infra-local.mjs` |
| Sobreposição do Modo B | `infra/local/workers.modo-b.yml` |
| Projetos Docker | `orbita-chatwoot` e `orbita-workers` (volumes nomeados persistentes) |

## 3. Operar

Rodar da raiz do checkout que tem esta branch:

```bash
node scripts/infra-local.mjs preparar
```

Cria a configuração só se ela não existir. Nunca sobrescreve segredo nem backup.

```bash
node scripts/infra-local.mjs iniciar
```

Sobe Postgres e Redis, prepara o banco do Chatwoot (idempotente), sobe o resto e constrói
e sobe os workers no Modo B.

```bash
node scripts/infra-local.mjs verificar
```

Confere a API do Chatwoot, as portas presas a `127.0.0.1` e, para cada worker: de pé,
sem reinício, sem rede, kill switch `false`, sem corte de backlog e com o log
`worker_desligado`. Imprime CPU e memória. Sai com 1 se alguma checagem falhar.

```bash
node scripts/infra-local.mjs parar
```

Para os containers. Os volumes ficam.

```bash
node scripts/infra-local.mjs atualizar
```

Reconstrói a imagem dos workers com o código do checkout e reaplica as migrações do
Chatwoot.

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
`contas=… conversas=… mensagens=…`. **Backup só vale depois de um restore que funcionou.**

- **Retenção:** `BACKUP_RETENTION_DAYS=0`, ou seja, nada é apagado automaticamente.
  Apagar backup antigo é decisão da proprietária.
- **Limite:** backup guardado só no notebook não protege contra perda, roubo ou defeito do
  equipamento. Para dado sintético isso basta. Para dado real, não.
- Nunca copiar dados do staging ou da produção para cá.

## 5. Acesso administrativo pelos dois notebooks (ação da proprietária)

Caminho escolhido: **Tailscale** (rede privada, sem porta no roteador) mais **OpenSSH
Server** no notebook host, aceitando só a tailnet e só por chave. O Windows Home não
hospeda RDP. O Chatwoot é aberto do outro notebook por túnel SSH, sem publicar nada.

1. **Nos dois notebooks**, instalar o Tailscale (pede UAC):

```bash
winget install --id Tailscale.Tailscale -e
```

2. Entrar na mesma conta nos dois, numa conta com **verificação em duas etapas** ligada
   (Google, Microsoft ou GitHub). O MFA do Tailscale é o do provedor de login.
3. **No notebook host**, em PowerShell como administrador, instalar o servidor SSH:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

```powershell
Set-Service sshd -StartupType Automatic; Start-Service sshd
```

4. Restringir a regra de firewall do SSH à faixa da tailnet. A regra padrão aceita
   qualquer origem:

```powershell
Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -RemoteAddress 100.64.0.0/10
```

5. Só chave, sem senha. Em `C:\ProgramData\ssh\sshd_config`, deixar
   `PasswordAuthentication no` e reiniciar com `Restart-Service sshd`. A chave pública do
   segundo notebook vai em `C:\ProgramData\ssh\administrators_authorized_keys`, porque a
   conta é administradora. Copie só a chave **pública** (`.pub`).
6. **No segundo notebook**, de qualquer rede:

```bash
ssh -L 8443:127.0.0.1:8443 kakau@<nome-do-host-na-tailnet>
```

Com o túnel aberto, `https://localhost:8443` no segundo notebook abre o Chatwoot do host.

Nunca expor Docker Engine, Postgres, Redis, PostgREST, SSH ou RDP à internet. Nada de
Tailscale Funnel nesta etapa.

## 6. Energia, tampa e reinício

Estado medido em 07/11/2026:

- Suspensão: **nunca**, na tomada e na bateria.
- Hibernação: nunca na tomada.
- Tampa: configuração oculta no esquema "Equilibrado". O padrão do Windows com Modern
  Standby (S0) é **suspender ao fechar a tampa**, e com isso os containers param.
- Docker Desktop abre no login (chave `Run` do usuário).
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
- fechar a tampa na bateria suspende;
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

Medição de 07/11/2026, Modo A e Modo B parados: cerca de 1,1 GB de RAM (rails cerca de
420 MB, sidekiq cerca de 500 MB, postgres cerca de 110 MB, workers cerca de 26 MB cada) e
CPU perto de 0%. A VM do Docker tem 8 GB, metade da RAM. O notebook tem 15,7 GB e
costuma ficar com pouca memória livre com navegador e IDE abertos.
