import { describe, expect, it } from 'vitest';

import {
  iniciarDiario,
  planejarExecucao,
  reconciliar,
  registrarConclusao,
  type DiarioDeExecucao,
  type RegistroEncontrado,
} from './execucaoSeed';
import {
  descreverSimulacao,
  limpezaPodeProsseguir,
  planejarLimpeza,
  relatarOrfaos,
} from './limpezaSegura';
import { buildSeedManifest } from './syntheticSeedData';

/**
 * Limpeza segura do seed.
 *
 * A limpeza roda contra o projeto Supabase compartilhado. A regra é uma só:
 * apaga-se o que esta execução criou, provado registro a registro, e nada
 * além. Divergência não é resolvida por aproximação — é recusa.
 *
 * Nada aqui apaga nada: os testes exercitam a decisão, não a execução.
 */

const PROJETO = 'etqjqeqqbjrzyyxodntv';

/** Diário completo: tudo planejado e tudo concluído, com ids previsíveis. */
function diarioCompleto(runId = 'run-1'): DiarioDeExecucao {
  const plano = planejarExecucao(buildSeedManifest({ runId }), PROJETO);
  return plano.operacoes.reduce(
    (diario, operacao, i) => registrarConclusao(diario, operacao.chave, `id-${i}`),
    iniciarDiario(plano),
  );
}

/** O que o projeto devolveria se tudo o que o diário registrou ainda existisse. */
function tudoPresente(diario: DiarioDeExecucao): RegistroEncontrado[] {
  const idPorChave = new Map(diario.concluidas.map((c) => [c.chave, c.idReal]));
  return diario.plano.operacoes.map((o) => ({
    identificador: o.identificador,
    id: idPorChave.get(o.chave)!,
  }));
}

describe('a identidade é conferida antes de qualquer exclusão', () => {
  it('tudo presente e conferido: todas aprovadas, nenhuma recusa', () => {
    const diario = diarioCompleto();

    const plano = planejarLimpeza(diario, tudoPresente(diario));

    expect(plano.aprovadas).toHaveLength(diario.plano.operacoes.length);
    expect(plano.recusadas).toEqual([]);
    expect(limpezaPodeProsseguir(plano)).toBe(true);
  });

  it('id divergente é recusado, e a limpeza inteira para', () => {
    // É o caso que mais importa: um slug pode ser reaproveitado, o id não. Se
    // o id mudou, o registro que está lá NÃO é o que criamos — apagá-lo seria
    // destruir dado de outra pessoa.
    const diario = diarioCompleto();
    const encontrados = tudoPresente(diario);
    encontrados[0] = { ...encontrados[0]!, id: 'id-de-outra-pessoa' };

    const plano = planejarLimpeza(diario, encontrados);

    expect(plano.recusadas).toHaveLength(1);
    expect(plano.recusadas[0]!.motivo).toMatchObject({ _tag: 'IdDivergente', encontrado: 'id-de-outra-pessoa' });
    expect(limpezaPodeProsseguir(plano)).toBe(false);
    // E o registro recusado não aparece entre os aprovados.
    expect(plano.aprovadas.map((a) => a.identificador)).not.toContain(encontrados[0]!.identificador);
  });

  it('a exclusão não é ampliada para registro que o projeto tem e o diário não', () => {
    const diario = diarioCompleto();
    const encontrados = [
      ...tudoPresente(diario),
      { identificador: 'orbita-e2e-run-1-intruso@e2e.orbita.test', id: 'id-intruso' },
      { identificador: 'cliente-de-verdade@empresa.com', id: 'id-real' },
    ];

    const plano = planejarLimpeza(diario, encontrados);

    const alvos = plano.aprovadas.map((a) => a.id);
    expect(alvos).not.toContain('id-intruso');
    expect(alvos).not.toContain('id-real');
  });

  it('apaga na ordem certa: membership, depois organização, depois usuário', () => {
    // Apagar a organização antes do membership deixaria membership órfão, ou
    // esbarraria na chave estrangeira.
    const plano = planejarLimpeza(diarioCompleto(), tudoPresente(diarioCompleto()));

    const tipos = plano.aprovadas.map((a) => a.tipo);
    const primeiroUsuario = tipos.indexOf('usuario');
    const ultimoMembership = tipos.lastIndexOf('membership');
    const ultimaOrganizacao = tipos.lastIndexOf('organizacao');

    expect(ultimoMembership).toBeLessThan(ultimaOrganizacao);
    expect(ultimaOrganizacao).toBeLessThan(primeiroUsuario);
  });
});

describe('limpeza repetida termina em sucesso', () => {
  it('tudo já removido: nada a apagar, nenhuma recusa', () => {
    // A segunda execução da limpeza encontra exatamente isto. Tratar como erro
    // faria toda retomada parecer falha.
    const diario = diarioCompleto();

    const plano = planejarLimpeza(diario, []);

    expect(plano.aprovadas).toEqual([]);
    expect(plano.jaRemovidas).toHaveLength(diario.plano.operacoes.length);
    expect(limpezaPodeProsseguir(plano)).toBe(true);
  });

  it('falha parcial: o que sobrou é apagado, o que já saiu é pulado', () => {
    const diario = diarioCompleto();
    const todos = tudoPresente(diario);
    // A primeira execução apagou os memberships e morreu.
    // Filtra por **tipo**, e não por prefixo de chave: os vínculos que as specs
    // criam entram no plano com a chave `spec:membership:…`, e um filtro de
    // prefixo os deixaria de fora — o teste diria "apagou os memberships"
    // tendo apagado só uma parte deles.
    const sobraram = todos.filter((_, i) => diario.plano.operacoes[i]!.tipo !== 'membership');

    const plano = planejarLimpeza(diario, sobraram);

    expect(plano.aprovadas.map((a) => a.tipo)).not.toContain('membership');
    expect(plano.jaRemovidas.every((o) => o.tipo === 'membership')).toBe(true);
    expect(limpezaPodeProsseguir(plano)).toBe(true);
  });

  it('operação que nunca concluiu não vira exclusão por semelhança', () => {
    // Sem id registrado não há o que conferir. Apagar pelo identificador seria
    // apagar por parecença — exatamente o que a conferência existe para impedir.
    const plano = planejarExecucao(buildSeedManifest({ runId: 'run-1' }), PROJETO);
    const diario = iniciarDiario(plano);
    const encontrados = plano.operacoes.map((o) => ({ identificador: o.identificador, id: 'id-qualquer' }));

    const limpeza = planejarLimpeza(diario, encontrados);

    expect(limpeza.aprovadas).toEqual([]);
    // Existem no projeto e o diário não registrou: são órfãs, não "já
    // removidas". Classificá-las como removidas escondia exatamente o caso que
    // o diário existe para revelar.
    expect(limpeza.naoRegistradas).toHaveLength(plano.operacoes.length);
    expect(limpeza.jaRemovidas).toEqual([]);
  });
});

describe('a simulação lista exatamente o que seria apagado', () => {
  it('nomeia projeto, execução, e cada registro com seu id', () => {
    const diario = diarioCompleto();
    const plano = planejarLimpeza(diario, tudoPresente(diario));

    const texto = descreverSimulacao(plano);

    expect(texto).toContain(`Projeto: ${PROJETO}`);
    expect(texto).toContain('Execução: run-1');
    for (const aprovada of plano.aprovadas) {
      expect(texto).toContain(aprovada.identificador);
      expect(texto).toContain(`id=${aprovada.id}`);
    }
  });

  it('a recusa aparece com o motivo, e o texto diz que a limpeza não prossegue', () => {
    const diario = diarioCompleto();
    const encontrados = tudoPresente(diario);
    encontrados[0] = { ...encontrados[0]!, id: 'id-de-outra-pessoa' };

    const texto = descreverSimulacao(planejarLimpeza(diario, encontrados));

    expect(texto).toContain('a limpeza NÃO prossegue');
    expect(texto).toContain('id-de-outra-pessoa');
  });

  it('nada a apagar é dito com todas as letras, e não com uma lista vazia', () => {
    const texto = descreverSimulacao(planejarLimpeza(diarioCompleto(), []));

    expect(texto).toContain('A APAGAR (0)');
    expect(texto).toContain('(nenhum)');
  });
});

describe('a busca de órfãos é limitada ao runId e é informativa', () => {
  it('encontra o que sobrou desta execução e o diário não conhece', () => {
    const diario = diarioCompleto();
    const plano = planejarLimpeza(diario, tudoPresente(diario));
    const orfao = { identificador: 'orbita-e2e-run-1-sobra@e2e.orbita.test', id: 'id-sobra' };

    const orfaos = relatarOrfaos([...tudoPresente(diario), orfao], 'run-1', plano);

    expect(orfaos).toEqual([orfao]);
  });

  it('não alcança execuções de outras pessoas, mesmo com o prefixo sintético', () => {
    // Filtro só por prefixo varreria o seed de outro operador rodando em
    // paralelo no mesmo projeto compartilhado.
    const diario = diarioCompleto();
    const plano = planejarLimpeza(diario, tudoPresente(diario));
    const deOutraExecucao = { identificador: 'orbita-e2e-run-9-owner-a@e2e.orbita.test', id: 'id-9' };

    expect(relatarOrfaos([deOutraExecucao], 'run-1', plano)).toEqual([]);
  });

  it('nunca inclui registro real, com ou sem runId no texto', () => {
    const diario = diarioCompleto();
    const plano = planejarLimpeza(diario, tudoPresente(diario));
    const real = { identificador: 'contato-run-1@empresa-de-verdade.com', id: 'id-real' };

    expect(relatarOrfaos([real], 'run-1', plano)).toEqual([]);
  });
});

/**
 * Ticket 23 — o vínculo que o **aceite do convite** cria.
 *
 * O seed não o escreve, e não deve: um convidado que já fosse membro faria a
 * spec passar sem provar o aceite. Mas o plano o prevê, como `spec`, e é isso
 * que permite à limpeza adotá-lo pelo identificador natural e apagá-lo
 * **explicitamente**.
 *
 * Antes disso ele era órfão: sumia junto da organização, por integridade
 * referencial, e não por ação da limpeza. Resultado certo por um caminho que
 * ninguém tinha afirmado — e no dia em que a cascade mudasse, o resíduo voltaria
 * calado.
 */
describe('o vínculo criado pelo aceite do convite é apagado pela limpeza', () => {
  /** O diário do seed: sem os registros de spec, porque o seed não os cria. */
  function diarioDoSeed(runId = 'run-1'): DiarioDeExecucao {
    const plano = planejarExecucao(buildSeedManifest({ runId }), PROJETO);
    return plano.operacoes
      .filter((o) => o.criadoPor === 'seed')
      .reduce((diario, operacao, i) => registrarConclusao(diario, operacao.chave, `id-seed-${i}`), iniciarDiario(plano));
  }

  function operacaoDoConvite(diario: DiarioDeExecucao) {
    const operacao = diario.plano.operacoes.find((o) => o.chave === 'spec:membership:convidado');
    if (!operacao) throw new Error('O plano não prevê o vínculo do convite.');
    return operacao;
  }

  /**
   * A limpeza como a orquestração a executa: **reconcilia primeiro**, planeja
   * depois. É o `reconciliar` que adota pelo identificador natural, e testar o
   * plano isolado não provaria a adoção — provaria só o que o diário já tinha.
   */
  function limpezaReconciliada(diario: DiarioDeExecucao, noProjeto: RegistroEncontrado[]) {
    const reconciliado = reconciliar(diario, noProjeto);
    return { reconciliado, plano: planejarLimpeza(reconciliado.diario, noProjeto) };
  }

  it('adota o vínculo pelo identificador natural, mesmo sem id no diário', () => {
    const diario = diarioDoSeed();
    const convite = operacaoDoConvite(diario);
    // O projeto tem o vínculo que a spec criou. O diário não — o seed não o
    // escreveu, então não há id gravado para ele.
    const noProjeto: RegistroEncontrado[] = [
      ...tudoPresente(diario).filter((r) => r.id !== undefined),
      { identificador: convite.identificador, id: 'id-real-do-vinculo-do-convite' },
    ];

    const { reconciliado, plano } = limpezaReconciliada(diario, noProjeto);

    expect(reconciliado.adotadas.map((a) => a.identificador)).toContain(convite.identificador);
    const aprovada = plano.aprovadas.find((a) => a.chave === convite.chave);
    expect(aprovada).toBeDefined();
    // O id vem do **projeto**, e não do diário: é o que "adotar" significa.
    expect(aprovada!.id).toBe('id-real-do-vinculo-do-convite');
  });

  // A ordem não é detalhe: apagar a organização antes do vínculo deixaria a
  // exclusão do vínculo acontecer por cascade — de novo o resultado certo pelo
  // caminho não afirmado.
  it('apaga o vínculo **antes** da organização do convite', () => {
    const diario = diarioDoSeed();
    const convite = operacaoDoConvite(diario);
    const noProjeto: RegistroEncontrado[] = [
      ...tudoPresente(diario).filter((r) => r.id !== undefined),
      { identificador: convite.identificador, id: 'id-real-do-vinculo-do-convite' },
    ];

    const chaves = limpezaReconciliada(diario, noProjeto).plano.aprovadas.map((a) => a.chave);
    const organizacaoDoConvite = diario.plano.operacoes.find((o) => o.chave === 'org:org-convite');

    expect(organizacaoDoConvite).toBeDefined();
    expect(chaves.indexOf(convite.chave)).toBeLessThan(chaves.indexOf(organizacaoDoConvite!.chave));
  });

  it('depois da limpeza não sobra órfão: tudo o que o projeto tem está no plano', () => {
    const diario = diarioDoSeed();
    const convite = operacaoDoConvite(diario);
    const noProjeto: RegistroEncontrado[] = [
      ...tudoPresente(diario).filter((r) => r.id !== undefined),
      { identificador: convite.identificador, id: 'id-real-do-vinculo-do-convite' },
    ];

    // `relatarOrfaos` é a pergunta certa: o que existe no projeto e o plano não
    // conhece. O vínculo do convite deixou de estar nessa lista.
    const { plano } = limpezaReconciliada(diario, noProjeto);
    expect(relatarOrfaos(noProjeto, diario.plano.runId, plano)).toEqual([]);
  });

  it('o vínculo que a spec não chegou a criar é "já removido", e não erro', () => {
    const diario = diarioDoSeed();
    // A suíte não rodou: o vínculo do convite não existe no projeto.
    const plano = planejarLimpeza(diario, tudoPresente(diario).filter((r) => r.id !== undefined));

    const convite = operacaoDoConvite(diario);
    expect(plano.jaRemovidas.map((o) => o.chave)).toContain(convite.chave);
    expect(limpezaPodeProsseguir(plano)).toBe(true);
  });
});
