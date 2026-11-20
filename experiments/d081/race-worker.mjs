import { parentPort, workerData } from 'node:worker_threads';
import { Atendimento } from './vertical.mjs';

const { file, id, key, version, action, barrier } = workerData;
const lab = new Atendimento(file, { channel: { send: async () => ({ id: 'synthetic' }) }, ready: true });
try {
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  while (Atomics.load(barrier, 0) < 2) {
    if (Atomics.wait(barrier, 0, 1, 5000) === 'timed-out') throw Error('barrier timeout');
  }
  if (action === 'dispatch') parentPort.postMessage(await lab.dispatch('A', id, key));
  else {
    lab.control('A', id, { action, actor: 'operator', key: 'race', expected: version });
    parentPort.postMessage(true);
  }
} finally {
  lab.close();
}
