import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Atendimento } from './vertical.mjs';

const account = '10';
const inbox = '20';
const op = { id: 'operator', active: true, manage: true };
const message = (id, options) => ({ account, inbox, conversation: '1', message: id, text: id, verifiedNew: true, ...options });
const answer = ({ messages, summary }) => ({ kind: 'answer', text: [summary, messages.at(-1).text].filter(Boolean).join(' / ') });

function laboratory(t, { model = answer, enabled = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orbita-d081-'));
  const file = join(dir, 'lab.sqlite');
  const sent = [];
  const changes = [];
  const statuses = new Map();
  const channel = {
    async readStatus(org, id) { return statuses.get(id) ?? 'open'; },
    async setStatus(org, id, status) { statuses.set(id, status); changes.push(status); },
    async send(org, id, job) {
      sent.push({ org, id, text: job.text, kind: job.kind }); return { id: String(sent.length) };
    },
  };
  let time = 0;
  const options = { model, channel, ready: true, now: () => time, leaseMs: 100 };
  const a = new Atendimento(file, options);
  const b = new Atendimento(file, options);
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
  a.provision('A', 'a', account, inbox, [op, { id: 'other', active: true, manage: true },
    { id: 'member', active: true, manage: false }]);
  a.provision('B', 'b', account, inbox, [op]);
  if (enabled) {
    a.policies('A', { platformAdmin: true }, true, { global: true });
    a.policies('A', op, true);
  }
  return { a, b, file, channel, sent, changes, statuses, tick: n => { time += n; } };
}

function command(a, id, action, options) {
  return a.control('A', id, { action, actor: op.id, key: action, expected: a.inspect('A', id).version, ...options });
}

async function start(a) {
  const id = a.receive('a', message('m1'));
  assert.equal(a.inspect('A', id).mode, 'PREPARING');
  assert.equal(await a.generate('A', id), false);
  assert.equal(await a.sync('A', id), true);
  assert.equal(a.inspect('A', id).mode, 'AI');
  assert.equal(a.inspect('A', id).owner, null);
  return id;
}

function last(a, id) { return a.inspect('A', id).jobs.at(-1); }

test('vertical: AI-first, escalation, human reply, explicit handback and resumed AI', async t => {
  const { a, b, sent, changes } = laboratory(t);
  const id = await start(a);
  assert.equal(a.receive('a', message('m1')), id);
  assert.equal(await a.generate('A', id), true);
  assert.equal(await b.dispatch('A', id, last(a, id).key), true);
  a.receive('a', message('m2', { requestHuman: true }));
  assert.equal(a.inspect('A', id).mode, 'HUMAN_REQUIRED');
  assert.equal(await a.sync('A', id), true);
  const version = command(a, id, 'takeover');
  const key = a.humanReply('A', id, op.id, 'h1', 'Atendimento humano');
  assert.equal(a.humanReply('A', id, op.id, 'h1', 'Atendimento humano'), key);
  assert.equal(await b.dispatch('A', id, key), true);
  assert.equal(await a.dispatch('A', id, key), false);
  assert.equal(await a.generate('A', id), false);
  const request = { action: 'handback', actor: op.id, key: 'back', expected: version, summary: 'Resumo privado' };
  assert.equal(a.control('A', id, request), b.control('A', id, request));
  assert.equal(await a.sync('A', id), true);
  assert.equal(await a.generate('A', id), false);
  a.receive('a', message('m3'));
  assert.equal(await b.generate('A', id), true);
  assert.equal(await a.dispatch('A', id, last(a, id).key), true);
  assert.deepEqual(sent.map(x => [x.id, x.kind, x.text]), [
    [id, 'ai', 'm1'], [id, 'human', 'Atendimento humano'], [id, 'ai', 'Resumo privado / m3'],
  ]);
  assert.deepEqual(changes, ['pending', 'open', 'pending']);
  assert.deepEqual(a.inspect('A', id).messages.map(m => m.id), ['m1', 'm2', 'm3']);
  assert.equal(a.inspect('A', id).audit.filter(x => x.reason === 'handback').length, 1);
});

test('default off, org AND global, verified new, binding and identical provider IDs across tenants', async t => {
  const { a, sent } = laboratory(t, { enabled: false });
  assert.throws(() => a.policies('A', op, true, { global: true }), /permission/);
  assert.throws(() => a.policies('A', { id: 'member' }, true), /permission/);
  assert.throws(() => a.receive('a', message('m1', { inbox: 'bad' })), /binding/);
  const ai = a.receive('a', message('m1'));
  const bi = a.receive('b', message('m1'));
  assert.notEqual(ai, bi);
  assert.throws(() => a.inspect('B', ai), /conversation/);
  a.policies('A', op, true);
  assert.equal(await a.generate('A', ai), false);
  a.policies('A', { platformAdmin: true }, true, { global: true });
  assert.equal(await a.generate('B', bi), false);
  a.receive('a', message('m2'));
  assert.equal(a.inspect('A', ai).mode, 'HUMAN_REQUIRED');
  const historical = a.receive('a', message('old', { conversation: 'older', verifiedNew: false }));
  assert.equal(a.inspect('A', historical).mode, 'HUMAN_REQUIRED');
  command(a, ai, 'takeover');
  assert.equal(await a.dispatch('A', ai, a.humanReply('A', ai, op.id, 'h', 'manual')), true);
  assert.deepEqual(sent.map(x => x.kind), ['human']);
});

test('takeover beats pending dispatch, stale pending event and handback authorization', async t => {
  const { a, b, sent } = laboratory(t);
  const id = await start(a);
  await a.generate('A', id);
  const job = last(a, id);
  command(b, id, 'takeover');
  assert.equal(await a.dispatch('A', id, job.key), false);
  assert.equal(last(b, id).state, 'invalidated');
  assert.equal(a.observeStatus('A', id, 'late-pending'), true);
  assert.equal(a.observeStatus('A', id, 'late-pending'), false);
  await a.sync('A', id);
  assert.equal(b.inspect('A', id).mode, 'HUMAN');
  assert.throws(() => command(b, id, 'handback', { actor: 'other', summary: 'x' }), /handback denied/);
  assert.throws(() => command(b, id, 'handback', { summary: ' ' }), /handback denied/);
  assert.equal(sent.length, 0);
});

test('late status echo only reads; an observed direct open stops future dispatch', async t => {
  const { a, changes, statuses } = laboratory(t);
  const id = await start(a);
  a.observeStatus('A', id, 'echo');
  await a.sync('A', id);
  assert.deepEqual(changes, ['pending']);
  await a.generate('A', id);
  // The remote operator has acted but the ORBITA has not received the event.
  statuses.set(id, 'open');
  assert.equal(await a.dispatch('A', id, last(a, id).key), true);
  a.receive('a', message('m2'));
  await a.generate('A', id);
  a.observeStatus('A', id, 'remote-open');
  assert.equal(await a.dispatch('A', id, last(a, id).key), false);
  await a.sync('A', id);
  assert.equal(a.inspect('A', id).mode, 'HUMAN_REQUIRED');
});

test('takeover during status POST preserves human ownership and converges to open', async t => {
  const { a, b, channel } = laboratory(t);
  const base = channel.setStatus;
  const admitted = Promise.withResolvers();
  const release = Promise.withResolvers();
  channel.setStatus = async (...args) => {
    if (args[2] === 'pending') { admitted.resolve(); await release.promise; }
    await base(...args);
  };
  const id = a.receive('a', message('m1'));
  const oldSync = a.sync('A', id);
  await admitted.promise;
  command(b, id, 'takeover');
  assert.equal(await b.sync('A', id), false);
  release.resolve();
  assert.equal(await oldSync, false);
  await b.sync('A', id);
  assert.equal(await channel.readStatus('A', id), 'open');
  assert.equal(b.inspect('A', id).owner, op.id);
});

test('generation lease recovery and new message fence reject old completions', async t => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let calls = 0;
  const { a, b, tick } = laboratory(t, { model: () => (++calls === 1 ? first.promise : second.promise) });
  const id = await start(a);
  const stale = a.generate('A', id);
  assert.equal(await b.generate('A', id), false);
  tick(101);
  const replacement = b.generate('A', id);
  first.resolve({ kind: 'answer', text: 'late' });
  assert.equal(await stale, false);
  a.receive('a', message('older timestamp', { createdAt: 1 }));
  second.resolve({ kind: 'answer', text: 'old context' });
  assert.equal(await replacement, false);
  assert.deepEqual(a.inspect('A', id).jobs, []);
});

test('off/on while model is running never restores the old authorization', async t => {
  const result = Promise.withResolvers();
  const { a, b } = laboratory(t, { model: () => result.promise });
  const id = await start(a);
  const pending = a.generate('A', id);
  b.policies('A', { platformAdmin: true }, false, { global: true });
  b.policies('A', { platformAdmin: true }, true, { global: true });
  result.resolve({ kind: 'answer', text: 'obsolete' });
  assert.equal(await pending, false);
  assert.deepEqual(a.inspect('A', id).jobs, []);
});

test('invalid model output, model escalation and model exception fail to human', async t => {
  const { a } = laboratory(t, { model: ({ messages }) => {
    if (messages.at(-1).id === 'error') throw Error('synthetic provider');
    return messages.at(-1).id === 'escalate' ? { kind: 'escalate' } : { kind: 'answer', text: '' };
  } });
  for (const reason of ['invalid', 'escalate', 'error']) {
    const id = a.receive('a', message(reason, { conversation: reason }));
    await a.sync('A', id);
    assert.equal(await a.generate('A', id), false);
    assert.equal(a.inspect('A', id).mode, 'HUMAN_REQUIRED');
    assert.deepEqual(a.inspect('A', id).jobs, []);
  }
});

test('committed dispatch beats takeover; timeout preserves unknown and prevents re-send and handback', async t => {
  const { a, b, channel, sent } = laboratory(t);
  const performed = Promise.withResolvers();
  const release = Promise.withResolvers();
  const orig = channel.send;
  channel.send = async (...args) => {
    await orig(...args);
    if (args[2].kind === 'ai') { performed.resolve(); await release.promise; throw Error('timeout'); }
    return { id: 'human receipt' };
  };
  const id = await start(a);
  await a.generate('A', id);
  const job = last(a, id);
  const sending = a.dispatch('A', id, job.key);
  await performed.promise;
  command(b, id, 'takeover');
  assert.equal(last(b, id).state, 'in_flight');
  release.resolve();
  assert.equal(await sending, false);
  assert.equal(last(b, id).state, 'unknown');
  assert.equal(await b.dispatch('A', id, job.key), false);
  assert.throws(() => command(b, id, 'handback', { summary: 'context' }), /handback denied/);
  assert.equal(await b.dispatch('A', id, b.humanReply('A', id, op.id, 'h', 'manual')), true);
  assert.deepEqual(sent.map(x => x.kind), ['ai', 'human']);
});

test('independent SQLite writers contend for takeover versus dispatch', async t => {
  const { a, file } = laboratory(t);
  const id = await start(a);
  await a.generate('A', id);
  const key = last(a, id).key;
  const version = a.inspect('A', id).version;
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  const url = new URL('./race-worker.mjs', import.meta.url);
  const results = ['dispatch', 'takeover'].map(action => new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { file, id, key, version, action, barrier } });
    worker.once('error', reject);
    worker.once('message', resolve);
    worker.once('exit', code => { if (code) reject(Error('race worker exit ' + code)); });
  }));
  const [dispatched, takeover] = await Promise.all(results);
  assert.equal(takeover, true);
  assert.equal(a.inspect('A', id).mode, 'HUMAN');
  assert.equal(last(a, id).state, dispatched ? 'sent' : 'invalidated');
});

test('status failure leaves automation blocked and keeps the human path available', async t => {
  const { a, b, channel } = laboratory(t);
  const id = a.receive('a', message('m1'));
  channel.setStatus = async () => { throw Error('ambiguous status POST'); };
  assert.equal(await a.sync('A', id), false);
  assert.equal(b.inspect('A', id).status.unknown, true);
  assert.equal(await b.generate('A', id), false);
  assert.equal(await b.sync('A', id), false);
  command(b, id, 'takeover');
  assert.equal(await b.dispatch('A', id, b.humanReply('A', id, op.id, 'h', 'manual')), true);
});
