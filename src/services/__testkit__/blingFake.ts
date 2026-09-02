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
}

/** Servidor fake: responde o que a fila mandar e guarda o que recebeu. */
export class BlingFake {
  private servidor: Server | null = null;
  readonly recebidas: RequisicaoCapturada[] = [];
  private fila: RespostaProgramada[] = [];
  private padrao: RespostaProgramada = { status: 200, body: JSON.stringify({ data: [] }) };

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
        });
        const resposta = this.fila.shift() ?? this.padrao;
        const responder = () => {
          if (res.destroyed) return;
          res.writeHead(resposta.status, { 'Content-Type': 'application/json', ...resposta.headers });
          res.end(resposta.body);
        };
        if (resposta.atrasoMs) {
          const timer = setTimeout(responder, resposta.atrasoMs);
          // O cliente que desiste fecha o socket; sem isto o servidor ficaria
          // segurando o processo de teste ate o timer disparar.
          res.on('close', () => clearTimeout(timer));
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
    this.fila.length = 0;
  }

  async parar(): Promise<void> {
    if (this.servidor) await new Promise<void>((resolve) => this.servidor!.close(() => resolve()));
  }
}
