import { describe, expect, it } from 'vitest';

import { lerConfiguracaoDoWorkerEnvio } from './workerEnvioChatwoot';

describe('configuração do worker de envio', () => {
  it('corte vazio, como vem no .env de modelo, é ausência: desligado sobe, ligado recusa', () => {
    expect(lerConfiguracaoDoWorkerEnvio({ CHATWOOT_SEND_WORKER_ENABLED: 'false', CHATWOOT_SEND_WORKER_BACKLOG_DESDE: '' }))
      .toMatchObject({ ligado: false });
    expect(() => lerConfiguracaoDoWorkerEnvio({ CHATWOOT_SEND_WORKER_ENABLED: 'true', CHATWOOT_SEND_WORKER_BACKLOG_DESDE: '' })).toThrow(/BACKLOG_DESDE/u);
  });

  it('corte inválido continua recusado', () => {
    expect(() => lerConfiguracaoDoWorkerEnvio({ CHATWOOT_SEND_WORKER_ENABLED: 'true', CHATWOOT_SEND_WORKER_BACKLOG_DESDE: 'ontem' })).toThrow();
  });
});
