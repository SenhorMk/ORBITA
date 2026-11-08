import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getHttpsLocal } from './infra-local-http.mjs';

/**
 * MSG-020C. Host local do notebook: Chatwoot do laboratório (Modo A) e workers
 * instalados, desligados e sem rede (Modo B). Uso, da raiz do repositório:
 *   node scripts/infra-local.mjs <preparar|iniciar|verificar|parar|atualizar|backup|restore>
 * Configuração e backups ficam em ORBITA_INFRA_DIR (padrão ~/orbita-infra), fora do
 * Git e fora do OneDrive. Ver docs/operations/msg-020c-runbook.md.
 */

const pasta = process.env.ORBITA_INFRA_DIR ?? join(homedir(), 'orbita-infra');
const envChatwoot = join(pasta, 'chatwoot.env');
const envWorkers = join(pasta, 'workers.env');
const backups = join(pasta, 'backups');
const PORTA_HTTPS = 8443;

const chatwoot = ['compose', '--env-file', envChatwoot, '-f', 'infra/chatwoot-vm/docker-compose.yml'];
const workers = ['compose', '-f', 'infra/worker/docker-compose.yml', '-f', 'infra/local/workers.modo-b.yml'];
const ambienteWorkers = { ...process.env, WORKER_ENV_FILE: envWorkers };

function docker(args, { env = process.env, mostrar = true } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, stdio: mostrar ? 'inherit' : 'pipe', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 6).join(' ')} falhou${mostrar ? '' : `: ${String(r.stderr).slice(-400)}`}`);
  return String(r.stdout ?? '');
}

function exigirPreparado() {
  if (!existsSync(envChatwoot) || !existsSync(envWorkers)) throw new Error(`Falta configuração em ${pasta}: rode "preparar".`);
}

/** Cria a configuração só se não existir: nunca sobrescreve segredo nem backup. */
function preparar() {
  mkdirSync(backups, { recursive: true });
  const segredo = () => randomBytes(32).toString('hex');
  if (!existsSync(envChatwoot)) {
    writeFileSync(envChatwoot, [
      '# MSG-020C, Modo A: Chatwoot do laboratório, só em 127.0.0.1. Dados sintéticos.',
      'CHATWOOT_DOMAIN=localhost',
      'ACME_EMAIL=laboratorio@example.invalid',
      'CHATWOOT_BIND=127.0.0.1',
      'CHATWOOT_HTTP_PORT=8080',
      `CHATWOOT_HTTPS_PORT=${PORTA_HTTPS}`,
      `CHATWOOT_SECRET_KEY_BASE=${segredo()}`,
      `CHATWOOT_POSTGRES_PASSWORD=${segredo()}`,
      `CHATWOOT_REDIS_PASSWORD=${segredo()}`,
      `BACKUP_DIR=${backups.replaceAll('\\', '/')}`,
      '# 0 = nenhum backup é apagado automaticamente.',
      'BACKUP_RETENTION_DAYS=0',
      'BACKUP_RCLONE_REMOTE=',
      '',
    ].join('\n'), { mode: 0o600 });
    console.log(`criado ${envChatwoot}`);
  }
  if (!existsSync(envWorkers)) {
    writeFileSync(envWorkers, [
      '# MSG-020C, Modo B: workers instalados e desligados, sem rede. Sem credencial real.',
      '# Conectar ao staging é outro gate: docs/operations/msg-020c-runbook.md §8.',
      'NEXT_PUBLIC_SUPABASE_URL=http://supabase.invalid',
      'SUPABASE_SERVICE_ROLE_KEY=sem-credencial-modo-b',
      'ENCRYPTION_KEY=',
      'WORKER_WATCHDOG_SECONDS=300',
      'CHATWOOT_INBOX_WORKER_ENABLED=false',
      'CHATWOOT_INBOX_WORKER_BACKLOG_DESDE=',
      'CHATWOOT_SEND_WORKER_ENABLED=false',
      'CHATWOOT_SEND_WORKER_BACKLOG_DESDE=',
      '',
    ].join('\n'), { mode: 0o600 });
    console.log(`criado ${envWorkers}`);
  }
  console.log(`configuração em ${pasta}`);
}

const engineNoAr = () => spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;

/** Abre o Docker Desktop do usuário se o engine não responde, e espera até 3 min. */
async function garantirDocker() {
  if (engineNoAr()) return;
  if (process.platform !== 'win32') throw new Error('Docker não responde: inicie o Docker.');
  console.log('Docker Desktop não está iniciado: abrindo...');
  const app = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
  if (!existsSync(app)) throw new Error(`Docker Desktop não encontrado em ${app}`);
  spawn(app, [], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 90 && !engineNoAr(); i += 1) await new Promise((r) => { setTimeout(r, 2_000); });
  if (!engineNoAr()) throw new Error('Docker Desktop não respondeu em 3 minutos.');
}

const SERVICOS = { chatwoot: ['caddy', 'rails', 'sidekiq', 'postgres', 'redis'], workers: ['inbox', 'envio'] };

function rodando(base, env) {
  const saida = docker([...base, 'ps', '--status', 'running', '--services'], { env, mostrar: false });
  return new Set(saida.split('\n').map((s) => s.trim()).filter(Boolean));
}

async function iniciar() {
  exigirPreparado();
  await garantirDocker();
  const noAr = new Set([...rodando(chatwoot), ...rodando(workers, ambienteWorkers)]);
  if ([...SERVICOS.chatwoot, ...SERVICOS.workers].every((s) => noAr.has(s))) {
    console.log('Laboratório já está no ar: nada a iniciar. Use "verificar".');
    return;
  }
  docker([...chatwoot, 'up', '-d', '--wait', 'postgres', 'redis']);
  // Idempotente: cria o banco na primeira vez e aplica migrações depois.
  docker([...chatwoot, 'run', '--rm', '--no-deps', 'rails', 'bundle', 'exec', 'rails', 'db:chatwoot_prepare']);
  docker([...chatwoot, 'up', '-d']);
  // Sem --build: a imagem existente basta; "atualizar" reconstrói.
  docker([...workers, 'up', '-d'], { env: ambienteWorkers });
}

const getLocal = (path) => getHttpsLocal({ port: PORTA_HTTPS, path, timeoutMs: 10_000 });

/**
 * O /api do Chatwoot responde `data_services: failing` quando a conexão do pool está
 * ociosa (`connection.active?`), com o banco saudável. Uma página que consulta o banco
 * reabre a conexão antes da checagem.
 */
async function apiDoChatwoot() {
  await getLocal('/app/login');
  return getLocal('/api');
}

async function verificar() {
  exigirPreparado();
  if (!engineNoAr()) throw new Error('Laboratório indisponível: o Docker Desktop não está iniciado. Rode "iniciar".');
  const falhas = [];
  const conferir = (ok, texto) => { console.log(`${ok ? 'ok   ' : 'FALHA'} ${texto}`); if (!ok) falhas.push(texto); };

  let api = await apiDoChatwoot();
  for (let i = 0; i < 40 && api.status !== 200; i += 1) {
    await new Promise((r) => setTimeout(r, 3_000));
    api = await apiDoChatwoot();
  }
  conferir(api.status === 200 && api.corpo.includes('"data_services":"ok"'), `Chatwoot https://localhost:${PORTA_HTTPS}/api → ${api.status}`);

  const publicadas = docker([...chatwoot, 'ps', '--format', 'json'], { mostrar: false }).split('\n').filter(Boolean)
    .flatMap((l) => (JSON.parse(l).Publishers ?? []).filter((p) => p.PublishedPort).map((p) => `${JSON.parse(l).Service}@${p.URL}:${p.PublishedPort}`));
  conferir(publicadas.length > 0 && publicadas.every((p) => p.startsWith('caddy@127.0.0.1:')), `portas publicadas só em 127.0.0.1: ${publicadas.join(', ')}`);

  for (const servico of SERVICOS.chatwoot) {
    const id = docker([...chatwoot, 'ps', '-q', servico], { mostrar: false }).trim();
    const [noAr, reinicios] = id ? docker(['inspect', '--format', '{{.State.Running}} {{.RestartCount}}', id], { mostrar: false }).trim().split(' ') : ['false', '?'];
    conferir(noAr === 'true' && reinicios === '0', `chatwoot ${servico} de pé, ${reinicios} reinícios inesperados`);
  }

  for (const servico of SERVICOS.workers) {
    const id = docker([...workers, 'ps', '-q', servico], { env: ambienteWorkers, mostrar: false }).trim();
    if (!id) { conferir(false, `worker ${servico} instalado`); continue; }
    // Reinício inesperado: um worker desligado não tem motivo para reiniciar.
    const [rodando, reinicios, rede] = docker(['inspect', '--format', '{{.State.Running}} {{.RestartCount}} {{.HostConfig.NetworkMode}}', id], { mostrar: false }).trim().split(' ');
    const env = docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', id], { mostrar: false });
    const chave = servico === 'inbox' ? 'CHATWOOT_INBOX_WORKER_ENABLED' : 'CHATWOOT_SEND_WORKER_ENABLED';
    const logs = spawnSync('docker', ['logs', id], { encoding: 'utf8' });
    conferir(rodando === 'true' && reinicios === '0', `worker ${servico} de pé, ${reinicios} reinícios`);
    conferir(rede === 'none', `worker ${servico} sem rede (${rede})`);
    conferir(env.includes(`${chave}=false`) && !/_BACKLOG_DESDE=\S/.test(env), `worker ${servico} com ${chave}=false e sem corte de backlog`);
    conferir(`${logs.stdout}${logs.stderr}`.includes(`chatwoot.${servico}.worker_desligado`), `worker ${servico} registrou worker_desligado`);
  }

  console.log(docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'], { mostrar: false }));
  console.log(docker(['system', 'df', '--format', '{{.Type}}\t{{.Size}}\t(recuperável {{.Reclaimable}})'], { mostrar: false }));
  if (falhas.length) throw new Error(`Laboratório com problema: ${falhas.length} verificação(ões) falharam.`);
  console.log(`Laboratório no ar: abra https://localhost:${PORTA_HTTPS}`);
}

function parar() {
  docker([...workers, 'stop'], { env: ambienteWorkers });
  docker([...chatwoot, 'stop']);
}

async function atualizar() {
  exigirPreparado();
  await garantirDocker();
  docker([...chatwoot, 'up', '-d', '--wait', 'postgres', 'redis']);
  docker([...chatwoot, 'run', '--rm', '--no-deps', 'rails', 'bundle', 'exec', 'rails', 'db:chatwoot_prepare']);
  docker([...chatwoot, 'up', '-d']);
  // Reconstrói a imagem dos workers com o código deste checkout e recria os containers.
  docker([...workers, 'up', '-d', '--build'], { env: ambienteWorkers });
}

/** Bash do Git for Windows; `bash` no PATH pode ser o do WSL. */
function bash() {
  if (process.platform !== 'win32') return 'bash';
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const candidato = resolve(execPath, '../../../bin/bash.exe');
  if (!existsSync(candidato)) throw new Error('bash do Git for Windows não encontrado');
  return candidato;
}

function script(nome, args = []) {
  exigirPreparado();
  const r = spawnSync(bash(), [`infra/chatwoot-vm/${nome}`, ...args], {
    stdio: 'inherit',
    // O Git Bash converteria /app/storage em caminho do Windows.
    env: { ...process.env, CHATWOOT_ENV_FILE: envChatwoot.replaceAll('\\', '/'), MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0) throw new Error(`${nome} falhou`);
}

const comandos = {
  preparar,
  iniciar,
  verificar,
  parar,
  atualizar,
  backup: () => script('backup.sh'),
  restore: () => script('restore-check.sh', process.argv.slice(3)),
};

const comando = comandos[process.argv[2]];
if (!comando) {
  console.error(`Uso: node scripts/infra-local.mjs <${Object.keys(comandos).join('|')}>`);
  process.exit(2);
}
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  await comando();
} catch (causa) {
  console.error(`[infra-local] ${causa instanceof Error ? causa.message : causa}`);
  process.exitCode = 1;
}
