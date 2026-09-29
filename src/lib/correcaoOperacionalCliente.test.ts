import { describe, expect, it, vi } from 'vitest';

import { mensagemDaCorrecao } from '@/lib/config/correcaoOperacionalContract';
import { cancelarDespesa, excluirContato, executarCorrecao } from './correcaoOperacionalCliente';

function resposta(status: number, corpo: unknown): Response {
  return { status, json: async () => corpo } as Response;
}

describe('executarCorrecao', () => {
  it('lê o desfecho pelo discriminador do contrato', async () => {
    const buscar = vi.fn(async () => resposta(409, { resultado: 'Blocked', motivo: 'possui_historico' }));
    expect(await executarCorrecao(buscar, '/x')).toEqual({ resultado: 'Blocked', motivo: 'possui_historico' });
  });

  it('corpo fora do contrato vira FalhaInesperada — o texto do servidor nunca chega à tela', async () => {
    const buscar = vi.fn(async () => resposta(500, { success: false, error: 'duplicate key value violates constraint' }));
    const desfecho = await executarCorrecao(buscar, '/x');
    expect(desfecho).toEqual({ resultado: 'FalhaInesperada' });
    expect(mensagemDaCorrecao(desfecho)).not.toContain('duplicate');
  });

  it('status que não bate com o resultado declarado não é aceito', async () => {
    const buscar = vi.fn(async () => resposta(200, { resultado: 'Blocked', motivo: 'possui_historico' }));
    expect(await executarCorrecao(buscar, '/x')).toEqual({ resultado: 'FalhaInesperada' });
  });

  it('403 da autorização vira SemPermissao', async () => {
    const buscar = vi.fn(async () => resposta(403, { success: false, error: 'Acesso negado' }));
    expect(await executarCorrecao(buscar, '/x')).toEqual({ resultado: 'SemPermissao' });
  });

  it('rede caída não lança: vira FalhaInesperada', async () => {
    const buscar = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await executarCorrecao(buscar, '/x')).toEqual({ resultado: 'FalhaInesperada' });
  });

  it('a exclusão de contato envia só o id local', async () => {
    const buscar = vi.fn(async () => resposta(200, { resultado: 'Deleted', removidoDoBling: false }));
    await excluirContato(buscar, 'cli-1');
    expect(buscar).toHaveBeenCalledWith('/api/clientes/delete', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ id: 'cli-1' }),
    }));
  });

  it('o cancelamento vai para a rota do título, sem corpo', async () => {
    const buscar = vi.fn(async () => resposta(200, { resultado: 'Cancelled' }));
    await cancelarDespesa(buscar, 't-1');
    expect(buscar).toHaveBeenCalledWith('/api/financeiro/titulos/t-1/cancelamento', expect.objectContaining({ body: undefined }));
  });
});
