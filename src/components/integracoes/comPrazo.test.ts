import { describe, expect, it, vi } from 'vitest';

import { comPrazo, MENSAGEM_DE_PRAZO_ESGOTADO, PRAZO_DA_INTEGRACAO_MS } from './comPrazo';

/**
 * O prazo das operações do painel (revisão externa da PR #85).
 *
 * `fetchWithAuth` não tem timeout e `fetch` também não: sem isto, uma
 * requisição travada deixa "Salvando…" na tela para sempre.
 */
/** A forma da busca autenticada, para os duplos declararem o tipo sem parametros mortos. */
type Busca = (url: string, options?: RequestInit) => Promise<Response>;

describe('comPrazo', () => {
  it('devolve a resposta normalmente quando o servidor responde a tempo', async () => {
    const resposta = { ok: true, status: 200 } as Response;
    const buscar = vi.fn<Busca>(async () => resposta);

    await expect(comPrazo(buscar, '/api/x')).resolves.toBe(resposta);
  });

  it('anexa um AbortSignal à requisição, sem tocar no seam global', async () => {
    const buscar = vi.fn<Busca>(async () => ({ ok: true, status: 200 }) as Response);

    await comPrazo(buscar, '/api/x', { method: 'POST' });

    const opcoes = buscar.mock.calls[0]?.[1];
    expect(opcoes?.method).toBe('POST');
    expect(opcoes?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uma requisição travada estoura o prazo em vez de ficar pendurada para sempre', async () => {
    // A requisição só termina quando o `signal` aborta — é o que um servidor
    // que não responde faz na prática.
    const buscar = vi.fn<Busca>((_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
    }));

    await expect(comPrazo(buscar, '/api/x', {}, 10)).rejects.toThrow(MENSAGEM_DE_PRAZO_ESGOTADO);
  });

  it('a mensagem do estouro diz que nada foi confirmado, e não que nada aconteceu', async () => {
    const buscar = vi.fn<Busca>((_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
    }));

    // A requisição pode ter chegado ao servidor. O prazo prova a ausência de
    // confirmação, não a ausência de efeito — e o texto não pode mentir sobre isso.
    await expect(comPrazo(buscar, '/api/x', {}, 10)).rejects.toThrow(/nada foi confirmado/i);
  });

  it('uma falha que não é de prazo chega ao chamador como ela mesma', async () => {
    const buscar = vi.fn<Busca>(async () => { throw new Error('Failed to fetch'); });

    await expect(comPrazo(buscar, '/api/x')).rejects.toThrow('Failed to fetch');
  });

  it('o prazo padrão é curto o bastante para uma operação de formulário', async () => {
    expect(PRAZO_DA_INTEGRACAO_MS).toBeLessThanOrEqual(60_000);
    expect(PRAZO_DA_INTEGRACAO_MS).toBeGreaterThanOrEqual(5_000);
  });
});
