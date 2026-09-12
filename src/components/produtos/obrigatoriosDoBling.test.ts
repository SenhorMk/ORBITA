import { describe, expect, it, vi } from 'vitest';

import { lerObrigatoriosDoBling } from './obrigatoriosDoBling';

function json(corpo: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo } as Response;
}

const REAIS = { tipo: 'S', situacao: 'I', formato: 'E', unidade: 'CX' };

describe('lerObrigatoriosDoBling', () => {
  it('devolve os valores reais do produto no ERP', async () => {
    const fetchWithAuth = vi.fn(async () => json({ success: true, obrigatorios: REAIS }));

    await expect(lerObrigatoriosDoBling(fetchWithAuth, '14077064')).resolves.toEqual(REAIS);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/produtos/bling/14077064');
  });

  it('null quando o provedor não respondeu — e null é bloqueio, não permissão', async () => {
    const fetchWithAuth = vi.fn(async () => json({ success: false, error: 'indisponível' }, 502));

    await expect(lerObrigatoriosDoBling(fetchWithAuth, '14077064')).resolves.toBeNull();
  });

  it('null quando a resposta vem fora do contrato', async () => {
    const fetchWithAuth = vi.fn(async () => json({ success: true, obrigatorios: { tipo: 'S' } }));

    await expect(lerObrigatoriosDoBling(fetchWithAuth, '14077064')).resolves.toBeNull();
  });

  it('null quando a unidade vem em branco', async () => {
    const fetchWithAuth = vi.fn(async () => json({ success: true, obrigatorios: { ...REAIS, unidade: '  ' } }));

    await expect(lerObrigatoriosDoBling(fetchWithAuth, '14077064')).resolves.toBeNull();
  });

  it('null quando a rede cai', async () => {
    const fetchWithAuth = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    await expect(lerObrigatoriosDoBling(fetchWithAuth, '14077064')).resolves.toBeNull();
  });

  it('nunca inventa padrão: o retorno é o do ERP ou nada', async () => {
    // A tentação seria devolver P/A/S/UN quando a leitura falha. É exatamente
    // isso que sobrescreveria o ERP no PUT seguinte.
    const fetchWithAuth = vi.fn(async () => json({}, 500));
    const resultado = await lerObrigatoriosDoBling(fetchWithAuth, '14077064');

    expect(resultado).toBeNull();
    expect(resultado).not.toMatchObject({ tipo: 'P' });
  });
});
