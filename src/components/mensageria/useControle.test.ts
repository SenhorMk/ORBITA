/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { useControle } from './useControle';

function resposta(modo: 'AI' | 'HUMAN', versao: number, ativa: boolean) {
  return Response.json({ success: true,
    controle: { modo, versao, responsavelId: modo === 'HUMAN' ? 'atendente' : null, souResponsavel: modo === 'HUMAN' },
    permissoes: { devolver: modo === 'HUMAN' && ativa, automacaoAtiva: ativa },
  });
}

describe('disponibilidade real do atendimento', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('atualiza a disponibilidade após a projeção e detecta desligamento sem novo clique', async () => {
    let ativa = false;
    const fetch = vi.fn(async () => resposta('AI', 3, ativa));
    const { result, unmount } = renderHook(() => useControle(fetch as AuthenticatedFetch, 'conversa-8'));
    await act(async () => {});
    expect(result.current.controle?.automacaoAtiva).toBe(false);
    ativa = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.controle?.automacaoAtiva).toBe(true);
    ativa = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.controle?.automacaoAtiva).toBe(false);
    unmount();
    const chamadas = fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(fetch).toHaveBeenCalledTimes(chamadas);
  });

  it('uma leitura em voo não desfaz o takeover confirmado', async () => {
    let concluirLeitura!: (r: Response) => void;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return resposta('HUMAN', 4, true);
      if (fetch.mock.calls.length === 1) return resposta('AI', 3, true);
      return new Promise<Response>((resolve) => { concluirLeitura = resolve; });
    });
    const { result, unmount } = renderHook(() => useControle(fetch as AuthenticatedFetch, 'conversa-8'));
    await act(async () => {});
    let leitura!: Promise<void>;
    act(() => { leitura = result.current.recarregar(); });
    await act(async () => { await result.current.agir('assumir'); });
    expect(result.current.controle?.modo).toBe('HUMAN');
    await act(async () => { concluirLeitura(resposta('AI', 3, true)); await leitura; });
    expect(result.current.controle?.modo).toBe('HUMAN');
    expect(result.current.controle?.versao).toBe(4);
    unmount();
  });
});
