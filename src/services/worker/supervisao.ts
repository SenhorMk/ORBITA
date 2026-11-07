/**
 * Supervisão de um processo worker em container (MSG-020A). Duas regras, e só:
 *
 * 1. **Travou, morre.** Cada volta do laço bate no vigia. Sem batida dentro do
 *    limite, o processo sai com erro e quem supervisiona (Docker, systemd)
 *    reinicia. Uma chamada pendurada ao banco ou ao provedor não fica parada
 *    para sempre segurando a lease.
 * 2. **Desligado, fica de pé.** Com o kill switch desligado o laço termina na
 *    hora; aqui o processo continua no ar, parado, até o sinal de parada. Sem
 *    isso, a política de reinício transforma o kill switch num laço de reinícios.
 *
 * Nada aqui decide trabalho: o laço de cada worker continua o mesmo.
 */
import { esperar } from '../chatwoot/workerInboxChatwoot';

export interface Vigia {
  readonly bater: () => void;
  readonly parar: () => void;
}

/**
 * @param limiteMs - Maior intervalo aceito entre duas batidas.
 * @param aoTravar - Chamado uma vez quando o limite estoura.
 * @param relogio - Injetável para teste.
 */
export function criarVigia(
  limiteMs: number,
  aoTravar: () => void,
  relogio: { readonly agora: () => number; readonly aCada: (fn: () => void, ms: number) => () => void } = {
    agora: Date.now,
    aCada: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  },
): Vigia {
  let ultima = relogio.agora();
  let disparou = false;
  const cancelar = relogio.aCada(() => {
    if (!disparou && relogio.agora() - ultima > limiteMs) {
      disparou = true;
      aoTravar();
    }
  }, Math.max(1_000, Math.floor(limiteMs / 4)));
  return {
    bater: () => { ultima = relogio.agora(); },
    parar: cancelar,
  };
}

/**
 * Roda o laço e, se ele terminar sem pedido de parada (worker desligado), mantém
 * o processo parado e batendo até o sinal.
 */
export async function manterNoAr(
  rodar: (sinal: AbortSignal, bater: () => void) => Promise<void>,
  sinal: AbortSignal,
  vigia: Vigia,
  intervaloParadoMs: number,
): Promise<'parado' | 'encerrado'> {
  vigia.bater();
  await rodar(sinal, vigia.bater);
  if (sinal.aborted) return 'encerrado';
  while (!sinal.aborted) {
    vigia.bater();
    await esperar(intervaloParadoMs, sinal);
  }
  return 'parado';
}
