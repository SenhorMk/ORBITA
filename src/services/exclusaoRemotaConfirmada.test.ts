import { describe, expect, it, vi } from 'vitest';

import type { ExclusaoRemota, LeituraRemota } from '../lib/integrations/bling/operacaoRemotaContract';
import { excluirComConfirmacao } from './exclusaoRemotaConfirmada';

function recurso(exclusao: ExclusaoRemota, leitura?: LeituraRemota<unknown>) {
  const excluir = vi.fn(async () => exclusao);
  const consultar = vi.fn(async () => {
    if (!leitura) throw new Error('a leitura não deveria ter sido feita');
    return leitura;
  });
  return { excluir, consultar };
}

const PRAZO: ExclusaoRemota = { _tag: 'RemotoIndeterminado', causa: 'prazo_esgotado' };

describe('excluirComConfirmacao', () => {
  it('2xx confirma a ausência sem leitura extra', async () => {
    const r = recurso({ _tag: 'ExclusaoAceita' });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'AusenciaConfirmada', comprovadaPor: 'exclusao' });
    expect(r.consultar).not.toHaveBeenCalled();
  });

  it('recusa definitiva não é confirmada por leitura nenhuma: nada mudou', async () => {
    const r = recurso({ _tag: 'RemotoRecusou', status: 400 });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'Recusada', status: 400 });
    expect(r.consultar).not.toHaveBeenCalled();
  });

  it('429 esgotado não foi processado', async () => {
    const r = recurso({ _tag: 'RemotoLimitado' });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'Limitada' });
  });

  it('ACK perdido + leitura 404 → ausência confirmada pela leitura', async () => {
    const r = recurso(PRAZO, { _tag: 'RemotoAusente' });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'AusenciaConfirmada', comprovadaPor: 'consulta' });
  });

  it('5xx + leitura 200 → o recurso continua lá', async () => {
    const r = recurso({ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' }, { _tag: 'RemotoPresente', valor: {} });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'RemotoAindaExiste' });
  });

  it('exclusão e leitura sem prova → indeterminada', async () => {
    const r = recurso(PRAZO, { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'Indeterminada' });
  });

  it('leitura recusada depois de exclusão sem resposta também não prova nada', async () => {
    const r = recurso(PRAZO, { _tag: 'RemotoRecusou', status: 403 });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'Indeterminada' });
  });

  it('o 404 do próprio DELETE passa pela leitura antes de virar ausência', async () => {
    const r = recurso({ _tag: 'RemotoAusente' }, { _tag: 'RemotoAusente' });
    expect(await excluirComConfirmacao(r)).toEqual({ _tag: 'AusenciaConfirmada', comprovadaPor: 'consulta' });
    expect(r.consultar).toHaveBeenCalledTimes(1);
  });

  it.each<[string, ExclusaoRemota, LeituraRemota<unknown>]>([
    ['prazo + ausente', PRAZO, { _tag: 'RemotoAusente' }],
    ['prazo + presente', PRAZO, { _tag: 'RemotoPresente', valor: {} }],
    ['prazo + indeterminado', PRAZO, { _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' }],
  ])('nunca manda um segundo DELETE (%s)', async (_caso, exclusao, leitura) => {
    const r = recurso(exclusao, leitura);
    await excluirComConfirmacao(r);
    expect(r.excluir).toHaveBeenCalledTimes(1);
  });
});
