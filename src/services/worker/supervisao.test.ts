import { describe, expect, it, vi } from 'vitest';

import { criarVigia, manterNoAr, vigiaCobreUmaPassada } from './supervisao';

function relogioManual() {
  let agora = 0;
  let verificar: () => void = () => {};
  return {
    relogio: { agora: () => agora, aCada: (fn: () => void) => { verificar = fn; return () => { verificar = () => {}; }; } },
    avancar(ms: number) { agora += ms; verificar(); },
  };
}

describe('vigia do worker', () => {
  it('sem batida além do limite, dispara uma vez só', () => {
    const { relogio, avancar } = relogioManual();
    const aoTravar = vi.fn();
    criarVigia(10_000, aoTravar, relogio);
    avancar(9_000);
    expect(aoTravar).not.toHaveBeenCalled();
    avancar(2_000);
    avancar(5_000);
    expect(aoTravar).toHaveBeenCalledTimes(1);
  });

  it('batida renova o prazo', () => {
    const { relogio, avancar } = relogioManual();
    const aoTravar = vi.fn();
    const vigia = criarVigia(10_000, aoTravar, relogio);
    for (let i = 0; i < 5; i += 1) {
      avancar(8_000);
      vigia.bater();
    }
    expect(aoTravar).not.toHaveBeenCalled();
  });

  it('parado, o vigia não dispara mais', () => {
    const { relogio, avancar } = relogioManual();
    const aoTravar = vi.fn();
    criarVigia(10_000, aoTravar, relogio).parar();
    avancar(60_000);
    expect(aoTravar).not.toHaveBeenCalled();
  });
});

describe('manterNoAr', () => {
  const vigia = () => ({ bater: vi.fn(), parar: vi.fn() });

  it('worker desligado: o laço termina, e o processo fica de pé até o sinal', async () => {
    const parada = new AbortController();
    const v = vigia();
    const resultado = manterNoAr(async () => {}, parada.signal, v, 5);
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(v.bater.mock.calls.length).toBeGreaterThan(2);
    parada.abort();
    await expect(resultado).resolves.toBe('parado');
  });

  it('parada durante o laço encerra sem estacionar', async () => {
    const parada = new AbortController();
    const resultado = manterNoAr(async (sinal) => {
      parada.abort();
      expect(sinal.aborted).toBe(true);
    }, parada.signal, vigia(), 5);
    await expect(resultado).resolves.toBe('encerrado');
  });

  it('o laço recebe a batida do vigia', async () => {
    const parada = new AbortController();
    const v = vigia();
    await manterNoAr(async (_sinal, bater) => { bater(); bater(); parada.abort(); }, parada.signal, v, 5);
    expect(v.bater).toHaveBeenCalledTimes(3);
  });
});

describe('limite do vigia contra o tamanho do lote', () => {
  it('padrão do envio cabe: 10 itens de até 10 s, com o dobro de margem, em 300 s', () => {
    expect(vigiaCobreUmaPassada(300_000, 10, 10_000)).toBe(true);
  });

  it('lote máximo do envio não cabe em 300 s: o vigia derrubaria um worker sadio', () => {
    expect(vigiaCobreUmaPassada(300_000, 50, 10_000)).toBe(false);
  });

  it('o limite mínimo é o dobro de lote × pior item', () => {
    expect(vigiaCobreUmaPassada(400_000, 20, 10_000)).toBe(true);
    expect(vigiaCobreUmaPassada(399_999, 20, 10_000)).toBe(false);
  });

  it('sem chamada a provedor (inbox), qualquer limite cobre', () => {
    expect(vigiaCobreUmaPassada(5_000, 50, 0)).toBe(true);
  });
});
