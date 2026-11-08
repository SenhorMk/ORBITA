import { describe, expect, it, vi } from 'vitest';

import { criarVigia, manterNoAr, vigiaCobreUmItem } from './supervisao';

/** Relógio em que a checagem do vigia roda no intervalo pedido, como o setInterval. */
function relogioManual() {
  let agora = 0;
  let intervalo = 1_000;
  let verificar: () => void = () => {};
  return {
    relogio: { agora: () => agora, aCada: (fn: () => void, ms: number) => { verificar = fn; intervalo = ms; return () => { verificar = () => {}; }; } },
    avancar(ms: number) {
      for (let passado = 0; passado < ms; passado += intervalo) { agora += Math.min(intervalo, ms - passado); verificar(); }
    },
    /** Host suspenso: o processo inteiro congela, e a checagem só roda de novo ao acordar. */
    suspender(ms: number) { agora += ms; verificar(); },
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

  it('suspensão do host não é travamento: o salto do relógio re-arma o prazo', () => {
    const { relogio, avancar, suspender } = relogioManual();
    const aoTravar = vi.fn();
    criarVigia(10_000, aoTravar, relogio);
    avancar(4_000);
    suspender(2 * 60 * 60 * 1_000);
    expect(aoTravar).not.toHaveBeenCalled();
    avancar(9_000);
    expect(aoTravar).not.toHaveBeenCalled();
  });

  it('depois da suspensão, sem batida além do limite, dispara', () => {
    const { relogio, avancar, suspender } = relogioManual();
    const aoTravar = vi.fn();
    criarVigia(10_000, aoTravar, relogio);
    suspender(2 * 60 * 60 * 1_000);
    avancar(12_000);
    expect(aoTravar).toHaveBeenCalledTimes(1);
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

describe('limite do vigia contra o pior item', () => {
  it('o padrão de 300 s cobre um envio de até 10 s, qualquer que seja o lote', () => {
    expect(vigiaCobreUmItem(300_000, 10_000)).toBe(true);
  });

  it('o limite mínimo é o dobro do pior item', () => {
    expect(vigiaCobreUmItem(20_000, 10_000)).toBe(true);
    expect(vigiaCobreUmItem(19_999, 10_000)).toBe(false);
  });

  it('sem chamada a provedor (inbox), qualquer limite cobre', () => {
    expect(vigiaCobreUmItem(5_000, 0)).toBe(true);
  });
});
