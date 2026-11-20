import { createServer } from 'node:http';
import { Atendimento } from '../d081/vertical.mjs';

const origin = 'http://127.0.0.1:55836';
const transcript = [];
let status = 'open';
let conversation;
let step = 0;
let busy = false;
const lab = new Atendimento(':memory:', {
  ready: true,
  model: async ({ summary }) => ({
    kind: 'answer',
    text: summary ? 'IA simulada: com o endereço confirmado, como posso ajudar agora?' : 'IA simulada: posso ajudar com sua entrega.',
  }),
  channel: {
    async readStatus() { return status; },
    async setStatus(_org, _id, desired) { status = desired; },
    async send(_org, _id, job) { transcript.push(job.text); return { id: String(transcript.length) }; },
  },
});
lab.provision('A', 'site', '1', '2', [{ id: 'ana', active: true, manage: true }]);
lab.policies('A', { platformAdmin: true }, true, { global: true });
lab.policies('A', { id: 'ana' }, true);

function receive(message, text, requestHuman = false) {
  transcript.push('Cliente: ' + text);
  conversation = lab.receive('site', { account: '1', inbox: '2', conversation: '1', message, text, requestHuman, verifiedNew: true });
}
function control(action, summary) {
  lab.control('A', conversation, { action, actor: 'ana', key: action, expected: lab.inspect('A', conversation).version, summary });
}
async function answer() {
  if (!await lab.generate('A', conversation)) throw Error('Geração recusada.');
  const job = lab.inspect('A', conversation).jobs.at(-1);
  if (!await lab.dispatch('A', conversation, job.key)) throw Error('Despacho recusado.');
}
const stages = [
  ['Enviar primeira mensagem', async () => { receive('m1', 'Você pode me ajudar com a entrega?'); await lab.sync('A', conversation); await answer(); }],
  ['Pedir atendente', async () => { receive('m2', 'Quero falar com uma pessoa.', true); await lab.sync('A', conversation); }],
  ['Assumir pelo ORBITA', async () => { control('takeover'); await lab.sync('A', conversation); }],
  ['Enviar resposta humana', async () => {
    const key = lab.humanReply('A', conversation, 'ana', 'h1', 'Ana: confirmei o endereço. Posso ajudar com mais alguma coisa?');
    await lab.dispatch('A', conversation, key);
  }],
  ['Devolver com resumo', async () => { control('handback', 'O endereço de entrega foi confirmado.'); await lab.sync('A', conversation); }],
  ['Cliente envia nova mensagem', async () => { receive('m3', 'Preciso de mais ajuda.'); await answer(); }],
];
function snapshot() {
  return { step, next: stages[step]?.[0] ?? null, transcript, status,
    control: conversation ? lab.inspect('A', conversation).mode : '—' };
}
const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>ORBITA — ensaio AI-first</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui;color:#1b2430;background:#f5f7fb;max-width:660px;margin:3rem auto;padding:0 1rem}main{background:#fff;padding:1.4rem;border:1px solid #d7deea;border-radius:12px}button{font:inherit;padding:.55rem .75rem}li{margin:.6rem 0}</style>
<main><h1>ORBITA · Conversa #1</h1><p>Ensaio sintético com SQLite. Modelo e canal simulados.</p>
<p id="estado" role="status"></p><ol id="historico" aria-label="Histórico da conversa"></ol>
<button id="avancar" type="button">Carregando…</button><p id="erro" role="alert"></p></main>
<script>
const botao = document.querySelector('#avancar');
async function mostrar(metodo) {
  botao.disabled = true;
  try {
    const r = await fetch('/conversa', {method: metodo});
    if (!r.ok) throw new Error('Não foi possível avançar. Reinicie o ensaio.');
    const e = await r.json();
    document.querySelector('#estado').textContent = 'Responsabilidade: ' + e.control + ' · Status remoto simulado: ' + e.status;
    document.querySelector('#historico').replaceChildren(...e.transcript.map(texto => {
      const item = document.createElement('li'); item.textContent = texto; return item;
    }));
    botao.textContent = e.next ?? 'Ensaio concluído';
    botao.disabled = !e.next;
  } catch(erro) { document.querySelector('#erro').textContent = erro.message; }
}
botao.addEventListener('click', () => mostrar('POST')); mostrar('GET');
</script></html>`;

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(html);
  } else if (req.url === '/conversa' && ['GET','POST'].includes(req.method)) {
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || busy || !stages[step]) { res.writeHead(409).end(); return; }
      busy = true;
      try { await stages[step][1](); step++; }
      catch { res.writeHead(500).end(); return; }
      finally { busy = false; }
    }
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(snapshot()));
  } else res.writeHead(404).end();
});
server.listen(55836, '127.0.0.1', () => console.log(origin));
