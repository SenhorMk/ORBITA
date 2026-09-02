import { describe, expect, it } from 'vitest';

import {
  iniciarDiario,
  lerDiario,
  operacoesPendentes,
  planejarExecucao,
  reconciliar,
  registrarConclusao,
} from './execucaoSeed';
import { buildSeedManifest, ORGANIZACAO_DO_CONVITE, PERSONA_CONVIDADA } from './syntheticSeedData';

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
    // 2 organizações do seed + 1 que a spec cria durante os testes: ela entra
    // no plano para a limpeza alcançá-la.
    // Ticket 23 — a organização do convite entrou, com dono próprio e um
    // convidado sem vínculo: +1 organização, +2 usuários, +1 membership.
    expect(porTipo).toEqual({ usuario: 7, organizacao: 4, membership: 7 });
  });

  it('a organização criada pela spec entra no plano, marcada como tal', () => {
    // Sem isto ela ficava fora de tudo: nenhum plano a conhecia, e sobrava no
    // projeto a cada execução.
    const plano = planejarExecucao(manifesto(), PROJETO);
    const daSpec = plano.operacoes.filter((o) => o.criadoPor === 'spec');

    // Três: a organização que a spec cria, o vínculo do convite aceito e o
    // vínculo de dono que nasce junto da organização da spec.
    expect(daSpec).toHaveLength(3);
    expect(daSpec[0]!.identificador).toContain('spec-created-org');
    expect(plano.operacoes.filter((o) => o.criadoPor === 'seed')).toHaveLength(15);
  });

  it('conclusão que diverge do projeto é reportada, sem reescrever o diário', () => {
    // Confiar no id gravado sem olhar era o buraco: a retomada reutilizava esse
    // id para criar membership, e um id obsoleto aponta para registro alheio.
    const plano = planejarExecucao(manifesto(), PROJETO);
    const primeira = plano.operacoes[0]!;
    const diario = registrarConclusao(iniciarDiario(plano), primeira.chave, 'id-do-diario');

    const resultado = reconciliar(diario, [{ identificador: primeira.identificador, id: 'id-do-projeto' }]);

    expect(resultado.divergentes).toEqual([{
      chave: primeira.chave,
      identificador: primeira.identificador,
      idNoDiario: 'id-do-diario',
      idNoProjeto: 'id-do-projeto',
    }]);
    // O diário é histórico: reescrevê-lo apagaria a prova do que foi criado.
    expect(resultado.diario.concluidas[0]!.idReal).toBe('id-do-diario');
  });

  it('conclusão ausente do projeto não é divergência — pode ter sido apagada', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const primeira = plano.operacoes[0]!;
    const diario = registrarConclusao(iniciarDiario(plano), primeira.chave, 'id-do-diario');

    expect(reconciliar(diario, []).divergentes).toEqual([]);
  });

  it('a persona externa não gera membership — ela existe justamente sem organização', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const memberships = plano.operacoes.filter((o) => o.tipo === 'membership');

    const doSeed = memberships.filter((m) => m.criadoPor === 'seed');
    expect(doSeed).toHaveLength(5);
    expect(doSeed.map((m) => m.chave)).not.toContain('membership:external');
    // Ticket 23 — o convidado não tem vínculo **do seed**, e é o ponto: ele
    // existe para **aceitar** um convite, e um seed que já o tornasse membro
    // faria a spec passar sem provar o aceite.
    expect(doSeed.map((m) => m.chave)).not.toContain(`membership:${PERSONA_CONVIDADA}`);

    // Mas o plano **prevê** o vínculo que o aceite cria, como `spec`. É o que
    // permite à limpeza adotá-lo pelo identificador natural e apagá-lo
    // explicitamente, antes da organização — em vez de deixá-lo sumir por
    // cascade, que é resultado certo por caminho não afirmado.
    const daSpec = memberships.filter((m) => m.criadoPor === 'spec');
    expect(daSpec.map((m) => m.chave)).toContain(`spec:membership:${PERSONA_CONVIDADA}`);
  });

  // Ticket 23 — os registros novos precisam entrar no **plano**, e não só no
  // manifesto. É o plano que o diário registra, que a retomada reconcilia e que
  // a limpeza apaga: um registro fora dele viraria órfão remoto invisível, que
  // é exatamente o que o diário existe para não deixar acontecer.
  it('a organização do convite e o convidado entram no plano, e a retomada os alcança', () => {
    const plano = planejarExecucao(manifesto(), PROJETO);
    const chaves = plano.operacoes.map((o) => o.chave);

    expect(chaves).toContain(`org:${ORGANIZACAO_DO_CONVITE}`);
    expect(chaves).toContain('persona:owner-convite');
    expect(chaves).toContain('membership:owner-convite');
    expect(chaves).toContain(`persona:${PERSONA_CONVIDADA}`);

    // A retomada depois de uma interrupção no meio: o que o diário não tem
    // continua pendente, e nada dos registros novos fica de fora.
    const diario = iniciarDiario(plano);
    const pendentes = operacoesPendentes(diario).map((o) => o.chave);
    for (const chave of [
      `org:${ORGANIZACAO_DO_CONVITE}`,
      'persona:owner-convite',
      'membership:owner-convite',
      `persona:${PERSONA_CONVIDADA}`,
    ]) {
      expect(pendentes).toContain(chave);
    }
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
      { agora: relogio('2026-08-31T13:00:00.000Z') },
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

it('com `adotarOperacoesDoSeed: false`, só o que a spec cria é adotado', () => {
    // A restrição em si, exercitada direto: é o que impede adotar registro do
    // seed fora de um estado de recuperação conhecido.
    const plano = planejarExecucao(manifesto(), PROJETO);
    const doSeed = plano.operacoes.find((o) => o.criadoPor === 'seed')!;
    const daSpec = plano.operacoes.find((o) => o.criadoPor === 'spec')!;

    const { recuperadas, adotadas } = reconciliar(
      iniciarDiario(plano),
      [
        { identificador: doSeed.identificador, id: 'id-do-seed' },
        { identificador: daSpec.identificador, id: 'id-da-spec' },
      ],
      { adotarOperacoesDoSeed: false },
    );

    expect(adotadas.map((a) => a.criadoPor)).toEqual(['spec']);
    expect(recuperadas.map((r) => r.chave)).toEqual([daSpec.chave]);
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
