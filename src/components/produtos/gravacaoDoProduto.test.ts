import { describe, expect, it, vi } from 'vitest';

import { buildProdutoRequest } from '@/lib/config/produtoContract';

import { gravarProduto } from './gravacaoDoProduto';

// O transporte é injetado em cada caso; o real só não pode montar o cliente
// Supabase do navegador neste ambiente.
vi.mock('@/lib/fetchWithAuth', () => ({ fetchWithAuth: vi.fn() }));

const payload = buildProdutoRequest({ nome: 'Camiseta', preco: 10 });

function respondendo(status: number, corpo: unknown, comoTexto = false) {
  return async () => new Response(comoTexto ? String(corpo) : JSON.stringify(corpo), { status });
}

describe('gravarProduto: o resultado que a tela usa para decidir (PRE-006B, revisão)', () => {
  it('reconciliação estruturada é indeterminada, com a mensagem do servidor', async () => {
    const resultado = await gravarProduto(payload, respondendo(502, {
      success: false, error: 'pode ter sido criado', reconciliacao: { motivo: 'bling_sem_confirmacao', blingId: null },
    }));

    expect(resultado).toMatchObject({ _tag: 'Indeterminado', motivo: 'bling_sem_confirmacao', mensagem: 'pode ter sido criado' });
  });

  it('504 do gateway (não é o JSON do contrato) é indeterminado, não recusa', async () => {
    expect(await gravarProduto(payload, respondendo(504, '<html>Gateway Timeout</html>', true)))
      .toMatchObject({ _tag: 'Indeterminado', motivo: 'resposta_perdida' });
  });

  it('5xx sem estado estruturado é indeterminado', async () => {
    expect(await gravarProduto(payload, respondendo(500, { success: false, error: 'falhou' })))
      .toMatchObject({ _tag: 'Indeterminado', motivo: 'resposta_perdida' });
  });

  it('rede caiu (TypeError) ou abort: indeterminado', async () => {
    const semRede = async (): Promise<Response> => { throw new TypeError('Failed to fetch'); };
    const abortado = async (): Promise<Response> => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };

    expect(await gravarProduto(payload, semRede)).toMatchObject({ _tag: 'Indeterminado', motivo: 'resposta_perdida' });
    expect(await gravarProduto(payload, abortado)).toMatchObject({ _tag: 'Indeterminado' });
  });

  it('sessão ausente lança antes de enviar: recusa, não indeterminado', async () => {
    const semSessao = async (): Promise<Response> => { throw new Error('Sua sessão expirou. Entre novamente para continuar.'); };

    expect(await gravarProduto(payload, semSessao)).toMatchObject({ _tag: 'Recusado', mensagem: 'Sua sessão expirou. Entre novamente para continuar.' });
  });

  it('recusa comprovada (4xx do contrato) e 403 de capacidade são recusas', async () => {
    expect(await gravarProduto(payload, respondendo(400, { success: false, error: 'O Bling recusou' })))
      .toMatchObject({ _tag: 'Recusado', mensagem: 'O Bling recusou' });
    expect(await gravarProduto(payload, respondendo(403, { success: false, error: 'Capacidade insuficiente' })))
      .toMatchObject({ _tag: 'Recusado' });
  });

  it('sucesso com avisos é parcial; sem avisos, concluído', async () => {
    expect(await gravarProduto(payload, respondendo(200, { success: true, saldo: 'nao_confirmado', avisos: ['saldo não confirmado'] })))
      .toEqual({ _tag: 'SalvoComAvisos', avisos: ['saldo não confirmado'] });
    expect(await gravarProduto(payload, respondendo(200, { success: true, saldo: 'aplicado', avisos: [] })))
      .toEqual({ _tag: 'Salvo' });
  });
});
