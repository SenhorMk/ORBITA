import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Servidor HTTP fake do Bling, compartilhado pelos testes de fronteira.
 *
 * Mora fora dos arquivos de teste porque duas suites o usam: os contract tests
 * do adapter e a guarda de payload de escrita (ticket 06). Duplicar um servidor
 * fake e como as duas metades comecam a divergir — que e a familia de defeito
 * que esta serie inteira persegue.
 *
 * Nao e mock de modulo: e HTTP de verdade, num socket de verdade. O que precisa
 * ser provado nesta fronteira e o caminho, a query e o corpo que saem pelo fio.
 */

export interface RequisicaoCapturada {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly authorization: string | undefined;
  /**
   * Instante em que a requisicao chegou (`Date.now()`).
   *
   * A fila do cliente **espaca** as requisicoes; ela nao as serializa ate o
   * fim. Entao o que prova a ordem nao e "quantas estao no ar", e sim a
   * distancia entre as chegadas — e isso so da para medir com o instante de
   * cada uma.
   */
  readonly em: number;
}

export interface RespostaProgramada {
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
  /**
   * Atraso antes de responder, para exercitar teto de tempo do lado do cliente.
   *
   * Existe porque um servidor que aceita a conexao e demora a responder e um
   * caso diferente de um que recusa — e so o primeiro prova que o `AbortSignal`
   * do chamador funciona.
   */
  readonly atrasoMs?: number;
  /**
   * Envia o cabecalho e um pedaco do corpo, e **nunca termina**.
   *
   * E o unico jeito de distinguir `response.body.cancel()` de
   * `await response.text()`: com um corpo finito, por maior que seja, as duas
   * coisas terminam e o teste nao ve diferenca. Com um corpo que nao acaba,
   * quem consome fica preso e quem cancela segue.
   */
  readonly corpoInterminavel?: boolean;
}

/** Uma espera por aborto, com o temporizador que precisa ser limpo junto. */
interface EsperaDeAborto {
  readonly resolve: () => void;
  readonly rejeitar: (erro: Error) => void;
  readonly limite: ReturnType<typeof setTimeout>;
}

/** Servidor fake: responde o que a fila mandar e guarda o que recebeu. */
export class BlingFake {
  private servidor: Server | null = null;
  readonly recebidas: RequisicaoCapturada[] = [];
  /**
   * Indices em `recebidas` cujo socket o cliente fechou antes da resposta.
   *
   * E o unico sinal, do lado do servidor, de que o `AbortSignal` chegou aquele
   * `fetch`. Um teto que so corre por fora devolve o controle ao chamador e
   * deixa a requisicao seguir ate o fim — e a diferenca entre os dois casos nao
   * aparece em nenhuma asercao de tempo.
   */
  readonly abortadas: number[] = [];
  private aguardando = new Map<number, EsperaDeAborto[]>();

  private fila: RespostaProgramada[] = [];
  private padrao: RespostaProgramada = { status: 200, body: JSON.stringify({ data: [] }) };

  /**
   * Resolve quando o cliente abortar a requisicao de indice `indice`.
   *
   * Substitui a espera fixa que o teste usava para "deixar o socket assentar":
   * um `setTimeout` de 200 ms passa a ser tempo demais numa maquina lenta e
   * tempo de sobra numa rapida, e o teste fica dependendo de qual das duas
   * executou. Aqui o sinal e o proprio evento.
   *
   * Cada espera limpa o proprio temporizador em **todos** os desfechos —
   * aborto, estouro de prazo, `limpar()` e `parar()` —, e varias esperas sobre
   * o mesmo indice sao atendidas juntas. Um waiter esquecido segura o processo
   * de teste depois da suite ter terminado, que e a forma mais chata de
   * vazamento num fake.
   */
  aguardarAborto(indice: number, timeoutMs = 5_000): Promise<void> {
    if (this.abortadas.includes(indice)) return Promise.resolve();

    const promessa = new Promise<void>((resolve, rejeitar) => {
      const espera = {
        resolve,
        rejeitar,
        limite: setTimeout(() => {
          this.removerEspera(indice, espera);
          rejeitar(new Error(`requisicao ${indice} nao foi abortada em ${timeoutMs} ms`));
        }, timeoutMs),
      };

      const existentes = this.aguardando.get(indice) ?? [];
      existentes.push(espera);
      this.aguardando.set(indice, existentes);
    });

    // Marca a rejeicao como observada sem consumi-la: quem faz `await` continua
    // recebendo o erro, e uma espera que ninguem aguardou — porque uma asercao
    // anterior falhou, por exemplo — nao derruba o processo do Vitest com
    // `unhandledRejection`, escondendo a falha original.
    promessa.catch(() => {});

    return promessa;
  }

  private removerEspera(indice: number, espera: EsperaDeAborto): void {
    clearTimeout(espera.limite);
    const restantes = (this.aguardando.get(indice) ?? []).filter((e) => e !== espera);
    if (restantes.length > 0) this.aguardando.set(indice, restantes);
    else this.aguardando.delete(indice);
  }

  /** Encerra todas as esperas pendentes, com o motivo dado. */
  private encerrarEsperas(motivo: string): void {
    for (const [indice, esperas] of this.aguardando) {
      for (const espera of esperas) {
        clearTimeout(espera.limite);
        espera.rejeitar(new Error(`espera pelo aborto da requisicao ${indice} cancelada: ${motivo}`));
      }
    }
    this.aguardando.clear();
  }

  async iniciar(): Promise<string> {
    this.servidor = createServer((req: IncomingMessage, res: ServerResponse) => {
      const pedacos: Buffer[] = [];
      req.on('data', (p: Buffer) => pedacos.push(p));
      req.on('end', () => {
        this.recebidas.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(pedacos).toString('utf8'),
          authorization: req.headers.authorization,
          em: Date.now(),
        });
        const indice = this.recebidas.length - 1;
        const resposta = this.fila.shift() ?? this.padrao;
        let respondida = false;
        const responder = () => {
          if (res.destroyed) return;
          respondida = true;
          res.writeHead(resposta.status, { 'Content-Type': 'application/json', ...resposta.headers });
          if (resposta.corpoInterminavel) {
            res.write(resposta.body);
            // Sem `end()`: o corpo fica aberto ate o cliente desistir.
            return;
          }
          res.end(resposta.body);
        };
        if (resposta.atrasoMs) {
          const timer = setTimeout(responder, resposta.atrasoMs);
          // O cliente que desiste fecha o socket; sem isto o servidor ficaria
          // segurando o processo de teste ate o timer disparar.
          res.on('close', () => {
            clearTimeout(timer);
            // Fechou antes da resposta: o cliente abortou. E a unica prova, do
            // lado do servidor, de que o `signal` chegou aquele `fetch` — o
            // teto externo sozinho devolveria o controle sem soltar o socket.
            if (!respondida) {
              this.abortadas.push(indice);
              const esperas = this.aguardando.get(indice) ?? [];
              this.aguardando.delete(indice);
              for (const espera of esperas) {
                clearTimeout(espera.limite);
                espera.resolve();
              }
            }
          });
          return;
        }
        responder();
      });
    });

    await new Promise<void>((resolve) => this.servidor!.listen(0, '127.0.0.1', resolve));
    const endereco = this.servidor!.address();
    if (typeof endereco === 'string' || endereco === null) throw new Error('servidor fake sem porta');
    return `http://127.0.0.1:${endereco.port}`;
  }

  programar(...respostas: RespostaProgramada[]): void {
    this.fila.push(...respostas);
  }

  definirPadrao(resposta: RespostaProgramada): void {
    this.padrao = resposta;
  }

  limpar(): void {
    this.recebidas.length = 0;
    this.abortadas.length = 0;
    this.encerrarEsperas('o fake foi limpo entre testes');
    this.fila.length = 0;
  }

  async parar(): Promise<void> {
    this.encerrarEsperas('o fake foi parado');
    if (this.servidor) await new Promise<void>((resolve) => this.servidor!.close(() => resolve()));
  }
}
