import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { applyCanonicalMigrations } from './database-lab.mjs';
import { createLocalDatabaseClient } from './local-database-client.mjs';

const diretorio = resolve('.orbita-demo-local');
const projeto = 'orbita-demo-d0306';
const api = 'http://127.0.0.1:55821';
const app = 'http://127.0.0.1:55830';
const canal = 'http://127.0.0.1:55831';
const cli = 'node_modules/supabase/dist/supabase.js';
const organizacao = '8d030600-0000-4000-8000-000000000001';
const conexao = '8d030600-0000-4000-8000-000000000002';
const email = 'atendente@orbita.test';
const senha = 'Orbita-Demo-2026!';
const comando = process.argv[2] ?? 'iniciar';

function supabase(args) {
  const r = spawnSync(process.execPath, [cli, ...args, '--workdir', diretorio], {
    encoding: 'utf8', timeout: 360000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', SUPABASE_ACCESS_TOKEN: '' },
  });
  if (r.status !== 0) throw new Error('Falha na CLI Supabase local: ' + args[0] + ' (exit ' + r.status + ').');
  return r.stdout;
}

function cifra(chave, valor) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(chave, 'hex'), iv);
  const texto = cipher.update(JSON.stringify(valor), 'utf8', 'hex') + cipher.final('hex');
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), texto].join(':');
}

function prepararConfig() {
  mkdirSync(resolve(diretorio, 'supabase'), { recursive: true });
  const config = readFileSync('supabase/config.toml', 'utf8')
    .replace('orbita-database-lab', projeto)
    .replace('54321', '55821').replace('54322', '55822').replace('54320', '55820')
    .replace(/(\[api\]\s*)enabled = false/u, '$1enabled = true')
    .replace(/(\[auth\]\s*)enabled = false/u, '$1enabled = true')
    .replace(/(\[realtime\]\s*)enabled = false/u, '$1enabled = true')
    .replace(/(\[db\.migrations\]\s*)enabled = true/u, '$1enabled = false');
  writeFileSync(resolve(diretorio, 'supabase/config.toml'), config);
}

async function semear(chave, token, hmac, serviceKey) {
  const banco = createLocalDatabaseClient('orbita-demo-seed', console, 55822);
  const resultado = await applyCanonicalMigrations({ client: banco });
  if (resultado._tag === 'err') throw new Error('Falha ao aplicar o ledger local: ' + resultado.error.message);
  const service = createClient(api, serviceKey, { auth: { persistSession: false } });
  const criado = await service.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (criado.error) throw new Error('Não foi possível criar o atendente sintético.');
  const usuario = criado.data.user.id;
  const db = createLocalDatabaseClient('orbita-demo-fixtures', console, 55822);
  await db.connect();
  try {
    await db.query("insert into public.organizacoes (id,nome,slug,status) values ($1,'ORBITA Demo','orbita-demo','active')", [organizacao]);
    await db.query("insert into public.membros_organizacao (organizacao_id,user_id,papel) values ($1,$2,'owner')", [organizacao, usuario]);
    await db.query("insert into public.conexoes_integracao (id,organizacao_id,provedor,nome,status) values ($1,$2,'chatwoot','Canal simulado','pendente')", [conexao, organizacao]);
    const cred = cifra(chave, { api_url: canal, api_token: token, account_id: '1', webhook_secret: hmac });
    await db.query('insert into public.credenciais_integracao (conexao_id,organizacao_id,dados_cifrados) values ($1,$2,$3)', [conexao, organizacao, cred]);
    await db.query(`do $$
      begin
        if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                       and schemaname = 'public' and tablename = 'chatwoot_messages') then
          alter publication supabase_realtime add table public.chatwoot_messages;
        end if;
        if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                       and schemaname = 'public' and tablename = 'chatwoot_conversations') then
          alter publication supabase_realtime add table public.chatwoot_conversations;
        end if;
      end $$; notify pgrst, 'reload schema';`);
  } finally { await db.end(); }
}

const pagina = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Cliente sintético · ORBITA</title>
<style>body{font:17px system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}textarea{width:100%;font:inherit}button{font:inherit;padding:.65rem;margin-top:.5rem}output{display:block;margin-top:1rem}</style>
<h1>Cliente sintético</h1><p>Canal Chatwoot simulado. A mensagem entra pelo webhook do ORBITA. O recibo de saída é simulado.</p>
<form method="post"><label for="mensagem">Mensagem do cliente</label><textarea required maxlength="500" id="mensagem" name="mensagem" rows="3"></textarea><button>Enviar mensagem</button></form>
<button type="button" id="falhar">Simular falha no próximo recibo</button>
<output role="status"></output><script>
document.querySelector('#falhar').onclick = async () => {
  const r = await fetch('/falhar', {method:'POST'});
  document.querySelector('output').textContent = r.ok ? 'Próximo recibo simulado indisponível.' : 'Não foi possível simular falha.';
};
document.querySelector('form').addEventListener('submit', async e => {
  e.preventDefault();
  const form=e.currentTarget, campo=form.elements.mensagem, botao=form.querySelector('button'), status=document.querySelector('output');
  botao.disabled=true;
  try {
    const r=await fetch('/', {method:'POST',body:new URLSearchParams({mensagem:campo.value})});
    status.textContent=r.ok?'Webhook aceitou a mensagem. Aguarde a inbox no ORBITA.':'O webhook recusou a mensagem.';
    if(r.ok) campo.value='';
  } catch { status.textContent='Canal local indisponível.'; }
  finally {botao.disabled=false;}
});
</script></html>`;

function servidorDoCanal(hmac, token) {
  let id = 59000;
  let falhar = false;
  return createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(pagina);
        return;
      }
      if (req.url === '/falhar' && req.method === 'POST' && req.headers.origin === canal) {
        falhar = true;
        res.writeHead(204).end();
        return;
      }
      if (req.url === '/' && req.method === 'POST' && req.headers.origin === canal) {
        let entrada = '';
        for await (const parte of req) {
          entrada += parte;
          if (entrada.length > 4096) { res.writeHead(413).end(); return; }
        }
        const content = new URLSearchParams(entrada).get('mensagem')?.trim();
        if (!content || content.length > 500) { res.writeHead(400).end(); return; }
        const created_at = Math.floor(Date.now() / 1000);
        const body = JSON.stringify({
          event: 'message_created', account: { id: 1 }, id: ++id, content, created_at,
          message_type: 'incoming', inbox: { id: 1 },
          conversation: { id: 575, inbox_id: 1, status: 'open', contact: { id: 15, name: 'Cliente Sintético' } },
          sender: { id: 15, name: 'Cliente Sintético', type: 'contact' },
        });
        const assinatura = createHmac('sha256', hmac).update(created_at + '.' + body).digest('hex');
        const r = await fetch(app + '/api/chatwoot/webhook/' + conexao, {
          method: 'POST', body, signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json', 'x-chatwoot-timestamp': String(created_at), 'x-chatwoot-signature': 'sha256=' + assinatura },
        });
        res.writeHead(r.ok ? 202 : 502).end();
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/accounts/1/conversations/575/messages'
        && req.headers.api_access_token === token) {
        req.resume();
        if (falhar) {
          falhar = false;
          res.writeHead(503).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: ++id, message_type: 'outgoing', created_at: new Date().toISOString(),
        }));
        return;
      }
      res.writeHead(404).end();
    } catch { res.writeHead(503).end(); }
  });
}

if (comando === 'parar') {
  prepararConfig();
  supabase(['stop', '--project-id', projeto, '--no-backup']);
  console.log('Banco sintético removido.');
} else if (comando === 'iniciar') {
  prepararConfig();
  const inventario = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (inventario.status !== 0 || inventario.stdout.includes(projeto)) throw new Error('Docker indisponível ou demo já criada. Use parar antes de reiniciar.');
  const chave = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const hmac = randomBytes(32).toString('hex');
  const filhos = [];
  const sim = servidorDoCanal(hmac, token);
  let iniciada = false;
  let encerrando = false;
  function parar() {
    if (encerrando) return;
    encerrando = true;
    for (const filho of filhos) filho.kill();
    sim.close();
    if (iniciada) supabase(['stop', '--project-id', projeto, '--no-backup']);
  }
  for (const sinal of ['SIGINT', 'SIGTERM']) process.once(sinal, parar);
  try {
    await new Promise((ok, erro) => {
      sim.once('error', erro);
      sim.listen(55831, '127.0.0.1', ok);
    });
    iniciada = true;
    supabase(['start']);
    const status = JSON.parse(supabase(['status', '-o', 'json']));
    if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Chaves locais indisponíveis.');
    await semear(chave, token, hmac, status.SERVICE_ROLE_KEY);
    const inicio = new Date().toISOString();
    const env = {
      ...process.env, NODE_ENV: 'development', NEXT_PUBLIC_ORBITA_DEMO_LOCAL: 'true',
      NEXT_PUBLIC_SUPABASE_URL: api, NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, ENCRYPTION_KEY: chave,
      GOOGLE_GENERATIVE_AI_API_KEY: '', SAC_RESPOSTA_PROVEDOR: 'fake', SAC_RESPOSTA_GEMINI_AUTORIZADO: 'false',
      SAC_TRIAGEM_PROVEDOR: 'fake', SAC_TRIAGEM_WORKER_ENABLED: 'true', SAC_TRIAGEM_LIMITE_DIARIO_POR_ORGANIZACAO: '25',
      CHATWOOT_INBOX_WORKER_ENABLED: 'true', CHATWOOT_SEND_WORKER_ENABLED: 'true',
      CHATWOOT_INBOX_WORKER_BACKLOG_DESDE: inicio, CHATWOOT_SEND_WORKER_BACKLOG_DESDE: inicio,
      NEXT_TELEMETRY_DISABLED: '1',
    };
    const iniciar = (nome, args) => {
      const filho = spawn(process.execPath, args, { env, stdio: 'inherit' });
      filhos.push(filho);
      filho.once('exit', (code) => {
        if (encerrando) return;
        console.error('[demo] Processo encerrado:', nome, code);
        process.exitCode = 1;
        parar();
      });
    };
    iniciar('app', ['node_modules/next/dist/bin/next', 'dev', '-H', '127.0.0.1', '-p', '55830']);
    for (const worker of ['inbox-chatwoot', 'triagem-sac', 'envio-chatwoot']) {
      iniciar(worker, ['node_modules/ts-node/dist/bin.js', '--transpile-only', '--project', 'scripts/tsconfig.worker.json', 'scripts/worker-' + worker + '.ts']);
    }
    console.log('ORBITA:', app, '| Cliente sintético:', canal, '| Conta:', email);
  } catch (erro) {
    console.error(erro instanceof Error ? erro.message : 'Falha na demo.');
    process.exitCode = 1;
    parar();
  }
} else {
  throw new Error('Use iniciar ou parar.');
}
