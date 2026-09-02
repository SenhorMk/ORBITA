import { describe, expect, it } from 'vitest';

import { FilaDeRequisicoes, esperar } from './filaDeRequisicoes';

/**
 * Ticket 31 — a fila de requisições.
 *
 * Estas provas atacam a fronteira **de dentro**, e não por perto dela. A
 * tentativa anterior media três chamadas concorrentes através do cliente HTTP e
 * ficava verde com a regressão reintroduzida: o espaçamento observado vinha do
 * relógio, não da porta, e era idêntico nos dois casos.
 *
 * Aqui o relógio e a espera são injetados, então **nesta suíte** nenhuma
 * asserção depende de tempo de parede: a máquina lenta não reprova o certo, nem
 * a rápida aprova o errado.
 *
 * A afirmação vale só para este arquivo. `bling-fila-e-prazo.test.ts` continua
 * com esperas reais, porque lá o assunto é o cliente HTTP inteiro e o que se
 * observa é trabalho de fundo assentando — dizer que a suíte toda está livre de
 * tempo de parede seria repetir o erro que esta série vem cometendo: afirmar
 * cobertura maior do que a que existe.
 */

/** Espera controlada: cada chamada fica pendente até o teste soltá-la. */
function esperaControlada() {
  const pendentes: Array<{ ms: number; signal?: AbortSignal; resolve: () => void; rejeitar: (e: unknown) => void }> = [];

  const dormir = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, rejeitar) => {
      const sair = () => {
        // Sai da lista: uma espera concluída ou abortada não pode ser
        // "concluída" de novo e roubar o lugar da próxima — foi assim que a
        // primeira versão deste helper travou um teste.
        const i = pendentes.indexOf(entrada);
        if (i >= 0) pendentes.splice(i, 1);
        signal?.removeEventListener('abort', aoAbortar);
      };

      const aoAbortar = () => {
        sair();
        rejeitar(signal?.reason);
      };

      const entrada = {
        ms,
        signal,
        // O listener é removido nos **dois** desfechos. Um dublê que vaza
        // listener é o tipo de coisa que só aparece como lentidão inexplicável
        // muitas suítes depois.
        resolve: () => { sair(); resolve(); },
        rejeitar,
      };

      pendentes.push(entrada);
      signal?.addEventListener('abort', aoAbortar, { once: true });
    });

  return {
    dormir,
    pendentes,
    /** Conclui a espera mais antiga ainda pendente. */
    concluirPrimeira(): void {
      const primeira = pendentes[0];
      if (!primeira) throw new Error('nenhuma espera pendente');
      primeira.resolve();
    },
  };
}

/** Relógio manual: nada avança sozinho. */
function relogio(inicial = 10_000) {
  let agora = inicial;
  return { agora: () => agora, avancar: (ms: number) => { agora += ms; } };
}

/** Deixa a microtask queue drenar, sem depender de tempo. */
const assentar = () => new Promise((r) => setImmediate(r));

describe('FilaDeRequisicoes — a ordem quando alguém desiste', () => {
  it('A → B → C: B que desiste esperando A não solta C antes de A', async () => {
    // O cenário da regressão, agora dentro de `aguardarVez` — que é onde a
    // decisão entre `liberar` e `encadearEm` acontece.
    const espera = esperaControlada();
    const tempo = relogio();
    const fila = new FilaDeRequisicoes({ agora: tempo.agora, dormir: espera.dormir, intervaloMs: 340 });

    const controleDeB = new AbortController();

    // Aquece: sem uma vez anterior, o intervalo é zero e A passaria direto.
    await fila.aguardarVez();

    // A toma a vez e fica nela: sua espera de intervalo não é concluída.
    let aPronta = false;
    const a = fila.aguardarVez().then(() => { aPronta = true; });
    await assentar();

    // B entra atrás de A e desiste antes de a vez chegar.
    let bFalhou = false;
    const b = fila.aguardarVez(controleDeB.signal).catch(() => { bFalhou = true; });
    await assentar();

    // C entra atrás de B.
    let cPronta = false;
    const c = fila.aguardarVez().then(() => { cPronta = true; });
    await assentar();

    controleDeB.abort(new Error('prazo de B'));
    await b;
    expect(bFalhou).toBe(true);

    // **A prova, e ela é sobre ONDE C está parado.**
    //
    // "C não terminou" não distingue nada: nos dois casos C fica pendente, ou
    // na porta ou no intervalo. Foi assim que a versão anterior desta prova
    // ficou verde com a regressão.
    //
    // O que distingue é quantas esperas de intervalo existem. Encadeada, a
    // porta de B só abre quando A libera, então **só A** está dormindo o
    // intervalo. Com a regressão, a porta de B abre na desistência, C toma a
    // vez e entra no próprio intervalo — e passam a existir duas.
    await assentar();
    expect(espera.pendentes).toHaveLength(1);
    expect(cPronta).toBe(false);
    expect(aPronta).toBe(false);

    // A conclui o intervalo e libera.
    espera.concluirPrimeira();
    await a;
    expect(aPronta).toBe(true);

    // Agora C anda — e ainda espera o próprio intervalo.
    await assentar();
    espera.concluirPrimeira();
    await c;
    expect(cPronta).toBe(true);
  });

  it('a desistência não trava a fila: o sucessor de quem desistiu chega a andar', async () => {
    const espera = esperaControlada();
    const tempo = relogio();
    const fila = new FilaDeRequisicoes({ agora: tempo.agora, dormir: espera.dormir });

    const controle = new AbortController();

    await fila.aguardarVez();
    const a = fila.aguardarVez();
    await assentar();
    const b = fila.aguardarVez(controle.signal).catch(() => 'desistiu');
    await assentar();
    const c = fila.aguardarVez();
    await assentar();

    controle.abort(new Error('prazo'));
    await b;

    espera.concluirPrimeira();
    await a;
    await assentar();
    espera.concluirPrimeira();

    await expect(c).resolves.toBeUndefined();
  });
});

describe('FilaDeRequisicoes — o relógio', () => {
  it('a vez usada avança o relógio, e o próximo espera só o que falta', async () => {
    const espera = esperaControlada();
    const tempo = relogio();
    const fila = new FilaDeRequisicoes({ agora: tempo.agora, dormir: espera.dormir, intervaloMs: 340 });

    // Primeira: não há vez anterior, então não espera intervalo nenhum.
    await fila.aguardarVez();
    expect(espera.pendentes).toHaveLength(0);

    // Segunda, 100 ms depois: espera os 240 que faltam — e é a **duração da
    // espera** que revela o relógio, sem precisar expor o campo.
    tempo.avancar(100);
    const segunda = fila.aguardarVez();
    await assentar();
    expect(espera.pendentes.map((p) => p.ms)).toEqual([240]);

    tempo.avancar(240);
    espera.concluirPrimeira();
    await segunda;

    // Terceira, imediatamente depois: o relógio avançou na segunda, então ela
    // espera o intervalo inteiro.
    const terceira = fila.aguardarVez();
    await assentar();
    expect(espera.pendentes.map((p) => p.ms)).toEqual([340]);
    espera.concluirPrimeira();
    await terceira;
  });

  it('quem desiste ANTES da vez não avança o relógio', async () => {
    // Se avançasse, empurraria a janela da requisição seguinte sem ter feito
    // requisição nenhuma. Observável pela duração que o sucessor espera.
    const espera = esperaControlada();
    const tempo = relogio();
    const fila = new FilaDeRequisicoes({ agora: tempo.agora, dormir: espera.dormir, intervaloMs: 340 });

    await fila.aguardarVez();
    const a = fila.aguardarVez();
    await assentar();

    const controle = new AbortController();
    const b = fila.aguardarVez(controle.signal).catch(() => 'desistiu');
    await assentar();

    // Passa muito tempo, e B desiste no meio dele.
    tempo.avancar(5_000);
    controle.abort(new Error('prazo'));
    await b;

    // A conclui. Se a desistência de B tivesse avançado o relógio, o próximo
    // esperaria menos — ou nada.
    espera.concluirPrimeira();
    await a;

    const proxima = fila.aguardarVez();
    await assentar();
    expect(espera.pendentes.map((p) => p.ms)).toEqual([340]);
    espera.concluirPrimeira();
    await proxima;
  });

  it('quem desiste DEPOIS de tomar a vez libera o sucessor na hora', async () => {
    // A outra metade da decisão: aqui `liberar()` é o certo, porque a vez foi
    // ocupada. Encadear neste caso prenderia o sucessor sem motivo.
    const espera = esperaControlada();
    const tempo = relogio();
    const fila = new FilaDeRequisicoes({ agora: tempo.agora, dormir: espera.dormir, intervaloMs: 340 });

    await fila.aguardarVez();

    const controle = new AbortController();
    const b = fila.aguardarVez(controle.signal).catch(() => 'desistiu');
    await assentar();
    expect(espera.pendentes).toHaveLength(1);

    controle.abort(new Error('prazo'));
    await b;

    let cPronta = false;
    const c = fila.aguardarVez().then(() => { cPronta = true; });
    await assentar();
    espera.concluirPrimeira();
    await c;
    expect(cPronta).toBe(true);
  });

  it('o padrão observa o prazo mesmo sem injeção nenhuma', async () => {
    // A classe promete observar o aborto. Se o `dormir` padrão ignorasse o
    // signal, ela estaria errada para todo mundo que a usa sem injetar peça —
    // e o teste com dublê nunca perceberia.
    const fila = new FilaDeRequisicoes({ intervaloMs: 60_000 });
    await fila.aguardarVez();

    const controle = new AbortController();
    const segunda = fila.aguardarVez(controle.signal);
    const motivo = new Error('prazo');
    controle.abort(motivo);

    await expect(segunda).rejects.toBe(motivo);
  });
});

describe('esperar', () => {
  it('resolve no tempo quando ninguém aborta', async () => {
    await expect(esperar(10)).resolves.toBeUndefined();
  });

  it('rejeita na hora do aborto, sem esperar o tempo todo', async () => {
    // É **aqui** que a espera cancelável se prova. No cliente HTTP o efeito não
    // é observável de fora: a conferência no topo do laço já impede a repetição
    // depois do prazo, então uma espera não-cancelável produziria a mesma
    // resposta — apenas segurando um temporizador por mais tempo. Um teste no
    // nível do cliente ficaria verde nos dois casos, e não seria prova.
    const controle = new AbortController();
    const motivo = new Error('prazo esgotado');

    const comecou = Date.now();
    const espera = esperar(5_000, controle.signal);
    controle.abort(motivo);

    await expect(espera).rejects.toBe(motivo);
    expect(Date.now() - comecou).toBeLessThan(1_000);
  });

  it('rejeita de imediato quando o prazo já estourou', async () => {
    const controle = new AbortController();
    const motivo = new Error('já era');
    controle.abort(motivo);

    await expect(esperar(5_000, controle.signal)).rejects.toBe(motivo);
  });
});
