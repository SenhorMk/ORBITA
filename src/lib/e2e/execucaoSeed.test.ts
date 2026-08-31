import { describe, expect, it } from 'vitest';

import {
  iniciarDiario,
  lerDiario,
  operacoesPendentes,
  planejarExecucao,
  reconciliar,
  registrarConclusao,
} from './execucaoSeed';
import { buildSeedManifest } from './syntheticSeedData';

/**
 * Diário de execução do seed.
 *
 * O seed escreve num projeto Supabase compartilhado: cria usuários de
 * autenticação, organizações e memberships de verdade. Sem diário, uma
 * interrupção no meio deixa registros remotos sem rastro local, e quem chega
 * depois não sabe o que existe nem o que apagar.
 *
 * Nada aqui toca a rede. Os testes exercitam a decisão, não a execução.
 */

const PROJETO = 'etqjqeqqbjrzyyxodntv';
const relogio = (iso: string) => () => new Date(iso);

function manifesto() {
  return buildSeedManifest({ runId: 'run-1' });
}

describe('o plano é escrito antes de qualquer escrita', () => {
  it('cobre usuários, organizações e memberships, e nomeia o projeto', () => {
    const plano = planejarExecucao(manifesto(), PROJETO, relogio('2026-08-31T12:00:00.000Z'));

    expect(plano.projetoRef).toBe(PROJETO);
    expect(plano.runId).toBe('run-1');
    expect(plano.criadoEm).toBe('2026-08-31T12:00:00.000Z');

    const porTipo = plano.operacoes.reduce<Record<string, number>>((acc, o) => {
      acc[o.tipo] = (acc[o.tipo] ?? 0) + 1;
      return acc;
    }, {});
    expect(porTipo).toEqual({ usuario: 5, organizacao: 2, membership: 4 });
  });

  it('a persona externa não gera membership — ela existe justamente sem organização', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const memberships = plano.operacoes.filter((o) => o.tipo === 'membership');

    expect(memberships).toHaveLength(4);
    expect(memberships.map((m) => m.chave)).not.toContain('membership:external');
  });

  it('todo identificador carrega o prefixo sintético e o runId', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);

    for (const operacao of plano.operacoes) {
      expect(operacao.identificador).toContain('orbita-e2e-');
      expect(operacao.identificador).toContain('run-1');
    }
  });

  it('recusa plano sem projeto — um diário que não diz onde rodou é inútil', () => {
    expect(() => planejarExecucao(manifesto(), '  ')).toThrow(/ref do projeto/u);
  });
});

describe('o progresso é registrado a cada operação', () => {
  it('a operação concluída sai das pendentes', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const chave = plano.operacoes[0]!.chave;

    const diario = registrarConclusao(iniciarDiario(plano), chave, 'id-real-1');

    expect(diario.concluidas).toHaveLength(1);
    expect(operacoesPendentes(diario).map((o) => o.chave)).not.toContain(chave);
  });

  it('registrar a mesma chave duas vezes atualiza, não duplica', () => {
    // Uma retomada reencontra operações já feitas; inflar o diário faria a
    // limpeza acreditar em registros que não existem.
    const plano = planejarExecucao(manifesto(), PROJETO);
    const chave = plano.operacoes[0]!.chave;

    const diario = registrarConclusao(
      registrarConclusao(iniciarDiario(plano), chave, 'id-antigo'),
      chave,
      'id-novo',
    );

    expect(diario.concluidas).toHaveLength(1);
    expect(diario.concluidas[0]!.idReal).toBe('id-novo');
  });

  it('recusa registro de operação fora do plano', () => {
    const diario = iniciarDiario(planejarExecucao(manifesto(), PROJETO));

    expect(() => registrarConclusao(diario, 'org:inventada', 'id')).toThrow(/fora do plano/u);
  });
});

describe('recuperação: a operação remota concluiu e o registro local falhou', () => {
  it('o que existe no projeto e falta no diário é recuperado', () => {
    // É o caso difícil: o usuário foi criado no Supabase e o processo morreu
    // antes de gravar o diário. Ignorar isso deixaria um órfão invisível.
    const plano = planejarExecucao(manifesto(), PROJETO);
    const diario = iniciarDiario(plano);
    const primeira = plano.operacoes[0]!;

    const { diario: recuperado, recuperadas } = reconciliar(
      diario,
      [{ identificador: primeira.identificador, id: 'id-que-existe-la' }],
      relogio('2026-08-31T13:00:00.000Z'),
    );

    expect(recuperadas.map((r) => r.chave)).toEqual([primeira.chave]);
    expect(recuperado.concluidas[0]).toEqual({
      chave: primeira.chave,
      idReal: 'id-que-existe-la',
      concluidaEm: '2026-08-31T13:00:00.000Z',
    });
  });

  it('não mexe no que o diário já registrou', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const primeira = plano.operacoes[0]!;
    const diario = registrarConclusao(iniciarDiario(plano), primeira.chave, 'id-registrado');

    const { recuperadas, diario: depois } = reconciliar(
      diario,
      [{ identificador: primeira.identificador, id: 'id-diferente' }],
    );

    // O diário é a autoridade sobre o que ele mesmo registrou; sobrescrever
    // aqui apagaria a única prova de qual id foi criado.
    expect(recuperadas).toEqual([]);
    expect(depois.concluidas[0]!.idReal).toBe('id-registrado');
  });

  it('registro fora do plano não é incorporado', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);

    const { recuperadas } = reconciliar(
      iniciarDiario(plano),
      [{ identificador: 'orbita-e2e-run-1-intruso@e2e.orbita.test', id: 'id-x' }],
    );

    expect(recuperadas).toEqual([]);
  });

  it('reconciliar duas vezes não duplica', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const primeira = plano.operacoes[0]!;
    const encontrados = [{ identificador: primeira.identificador, id: 'id-1' }];

    const um = reconciliar(iniciarDiario(plano), encontrados).diario;
    const dois = reconciliar(um, encontrados).diario;

    expect(dois.concluidas).toHaveLength(1);
  });
});

describe('um diário lido do disco é validado antes de qualquer uso', () => {
  function diarioValido() {
    const plano = planejarExecucao(manifesto(), PROJETO);
    return registrarConclusao(iniciarDiario(plano), plano.operacoes[0]!.chave, 'id-1');
  }

  it('aceita o diário da execução e do projeto esperados', () => {
    const leitura = lerDiario(diarioValido(), { projetoRef: PROJETO, runId: 'run-1' });

    expect(leitura._tag).toBe('DiarioValido');
  });

  it('recusa diário de outro projeto', () => {
    // Agir sobre o diário de outro projeto é exatamente como uma limpeza
    // apagaria o que não criou.
    const leitura = lerDiario(diarioValido(), { projetoRef: 'outro-projeto' });

    expect(leitura).toMatchObject({
      _tag: 'DiarioRecusado',
      motivo: { _tag: 'ProjetoDivergente', encontrado: PROJETO },
    });
  });

  it('recusa diário de outra execução', () => {
    const leitura = lerDiario(diarioValido(), { projetoRef: PROJETO, runId: 'run-2' });

    expect(leitura).toMatchObject({ _tag: 'DiarioRecusado', motivo: { _tag: 'RunIdDivergente' } });
  });

  it.each([
    ['nulo', null],
    ['texto', 'diario'],
    ['sem plano', { concluidas: [] }],
    ['sem concluídas', { plano: {} }],
    ['plano incompleto', { plano: { projetoRef: PROJETO }, concluidas: [] }],
  ])('recusa diário %s', (_nome, bruto) => {
    expect(lerDiario(bruto, { projetoRef: PROJETO })).toMatchObject({
      _tag: 'DiarioRecusado',
      motivo: { _tag: 'FormaInvalida' },
    });
  });

  it('recusa diário cujos identificadores não são sintéticos', () => {
    // Salvaguarda contra apontar a limpeza para dados reais montando um
    // arquivo à mão.
    const bruto = {
      plano: {
        projetoRef: PROJETO,
        runId: 'producao',
        criadoEm: '2026-08-31T00:00:00.000Z',
        operacoes: [{ tipo: 'organizacao', chave: 'org:real', identificador: 'cliente-de-verdade' }],
      },
      concluidas: [],
    };

    expect(lerDiario(bruto, { projetoRef: PROJETO })).toMatchObject({
      _tag: 'DiarioRecusado',
      motivo: { _tag: 'FormaInvalida' },
    });
  });
});
