/**
 * Fila que espaça as requisições a um provedor externo, cedendo a vez sob prazo.
 *
 * Mora fora de `bling.ts` porque é uma peça com contrato e estado próprios, e
 * não um detalhe do cliente: quem chama precisa saber que existe uma ordem, que
 * ela é preservada quando alguém desiste, e que o relógio só avança quando a
 * vez é usada. Enquanto isso era um punhado de campos soltos dentro do
 * `BlingClient`, o estado ficava implícito — e foi exatamente aí que a ordenação
 * quebrou uma vez.
 *
 * O relógio e a espera são injetáveis porque **as duas coisas que esta classe
 * promete são temporais**. Testá-las com tempo de parede transforma a prova em
 * aposta: uma máquina lenta reprova o certo, uma rápida aprova o errado.
 *
 * A superfície pública é só `aguardarVez`. A porta, o encadeamento e o relógio
 * interno são detalhes: expô-los para facilitar teste transformaria decisões
 * internas em contrato, e o que precisa ser provado dá para provar pelo que
 * `aguardarVez` faz — quantas esperas abre, de quanto tempo, e em que ordem.
 */

/** Espera cancelável, na forma que a fila consome. */
export type Dormir = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * A vez de um participante na fila.
 *
 * São **dois** desfechos distintos, e o tipo obriga a escolher entre eles:
 *
 * - `liberar()` — a vez foi usada, o sucessor pode seguir agora;
 * - `encadearEm(anterior)` — a vez foi abandonada, e o sucessor só segue quando
 *   o predecessor liberar. É o que preserva a ordem.
 *
 * A distinção existe porque abrir a porta na desistência deixa o sucessor
 * ultrapassar um predecessor que ainda não terminou.
 */
class PortaDaFila {
  private abrir: () => void = () => {};
  readonly aberta: Promise<void>;

  constructor() {
    this.aberta = new Promise<void>((resolve) => { this.abrir = resolve; });
  }

  liberar(): void {
    this.abrir();
  }

  encadearEm(anterior: Promise<void>): void {
    // Resolve nos dois desfechos do predecessor: a fila não pode travar porque
    // alguém antes dela falhou.
    anterior.then(() => this.abrir(), () => this.abrir());
  }
}

export interface OpcoesDaFila {
  readonly intervaloMs?: number;
  readonly agora?: () => number;
  readonly dormir?: Dormir;
}

export class FilaDeRequisicoes {
  private ultimaPorta: Promise<void> = Promise.resolve();
  private ultimaVezUsadaEm = 0;

  private readonly intervaloMs: number;
  private readonly agora: () => number;
  private readonly dormir: Dormir;

  constructor(opcoes: OpcoesDaFila = {}) {
    this.intervaloMs = opcoes.intervaloMs ?? 340;
    this.agora = opcoes.agora ?? Date.now;
    // O padrão é a espera **cancelável**. Um `setTimeout` cru aqui tornaria a
    // classe errada sem a injeção certa: ela promete observar o prazo, e a
    // promessa não pode depender de quem a constrói lembrar de passar a peça
    // que a cumpre.
    this.dormir = opcoes.dormir ?? esperar;
  }

  /**
   * Espera a vez e o intervalo mínimo desde a última requisição.
   *
   * As **duas** esperas observam o aborto — a do predecessor e a do intervalo.
   * Quem chega já fora do prazo não fica preso atrás de outro.
   *
   * @throws o motivo do `signal` quando o prazo estoura em qualquer das duas.
   */
  async aguardarVez(signal?: AbortSignal): Promise<void> {
    const anterior = this.ultimaPorta;
    const porta = new PortaDaFila();
    this.ultimaPorta = porta.aberta;

    // Só depois de a vez ser efetivamente tomada é que a porta pode abrir
    // sozinha. Antes disso, ela pertence à ordem, não a esta chamada.
    let vezTomada = false;

    try {
      await esperarOuDesistir(anterior, signal);
      vezTomada = true;

      const aEsperar = Math.max(0, this.intervaloMs - (this.agora() - this.ultimaVezUsadaEm));
      if (aEsperar > 0) {
        await this.dormir(aEsperar, signal);
      }

      // O relógio só avança aqui. Uma chamada que expirou antes disto não
      // empurra a janela da requisição seguinte sem ter feito requisição
      // nenhuma.
      this.ultimaVezUsadaEm = this.agora();
    } finally {
      if (vezTomada) {
        porta.liberar();
      } else {
        // Desistiu **antes** de a vez chegar. Abrir aqui deixaria o sucessor
        // ultrapassar um predecessor que ainda está requisitando: no cenário
        // A → B → C, um B que expira esperando A liberaria C para partir sem a
        // vez de A ter terminado.
        porta.encadearEm(anterior);
      }
    }
  }
}

/**
 * Espera uma promessa qualquer, desistindo quando o prazo estoura.
 *
 * A promessa original **continua** — quem a criou é que decide o destino dela.
 * Isto só solta quem estava esperando: a vez do predecessor não é cancelável,
 * mas ninguém precisa ficar preso a ela depois do prazo.
 */
function esperarOuDesistir<T>(promessa: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promessa;

  const prazo = signal;
  if (prazo.aborted) return Promise.reject(prazo.reason);

  return new Promise<T>((resolve, rejeitar) => {
    const aoAbortar = () => rejeitar(prazo.reason);
    prazo.addEventListener('abort', aoAbortar, { once: true });

    promessa.then(resolve, rejeitar).finally(() => {
      prazo.removeEventListener('abort', aoAbortar);
    });
  });
}

/**
 * Espera que o prazo consegue interromper.
 *
 * `setTimeout` cru não é cancelável de fora, e era por isso que a fila do rate
 * limit e o backoff de 429 continuavam correndo depois de a chamada ter sido
 * abandonada. Com isto, uma chamada fora do prazo solta a vez em vez de segurar
 * a fila até o fim do intervalo.
 */
export function esperar(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

  const prazo = signal;
  // Rejeição, não exceção síncrona: a função declara `Promise`, e quem a trata
  // com `.catch` em vez de `await` não pode receber um comportamento diferente
  // por causa do momento em que o prazo estourou.
  if (prazo.aborted) return Promise.reject(prazo.reason);

  return new Promise((resolve, rejeitar) => {
    const aoAbortar = () => {
      clearTimeout(temporizador);
      rejeitar(prazo.reason);
    };

    const temporizador = setTimeout(() => {
      prazo.removeEventListener('abort', aoAbortar);
      resolve();
    }, ms);

    prazo.addEventListener('abort', aoAbortar, { once: true });
  });
}
