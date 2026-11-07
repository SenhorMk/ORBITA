import { describe, expect, it, vi } from 'vitest';

import { criarVigia, manterNoAr } from './supervisao';

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
