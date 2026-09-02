import { describe, expect, it, vi } from 'vitest';

import { lerDiario, planejarExecucao, type DiarioDeExecucao, type RegistroEncontrado } from './execucaoSeed';
import { executarLimpeza, executarSeed } from './orquestracao';
import type {
  EscritaNoProjeto,
  ExclusaoNoProjeto,
  LeituraDoProjeto,
  PortaDoProjeto,
} from './portaDoProjeto';
import { buildSeedManifest } from './syntheticSeedData';

/**
 * Execução do seed e da limpeza, com falhas simuladas.
 *
 * Nenhum destes casos toca rede ou disco: a porta do projeto é um dublê que
 * sabe falhar na hora exata, e o diário é gravado numa variável. O que está sob
 * teste é o que o orquestrador faz **quando dá errado** — que é onde os
 * defeitos moravam.
 */

const PROJETO = 'etqjqeqqbjrzyyxodntv';
const RUN = 'run-1';

interface FalhasSimuladas {
  /** Falha na escrita de índice N daquele tipo (0 = a primeira). */
  readonly escritaFalhaEm?: { readonly tipo: 'usuario' | 'organizacao' | 'membership'; readonly indice: number };
  readonly leituraFalhaEm?: 'usuarios' | 'organizacoes' | 'memberships';
  readonly exclusaoFalhaEm?: number;
  /** Registros que já existem no projeto antes de o seed começar. */
  readonly jaExistentes?: readonly RegistroEncontrado[];
}

/** Projeto em memória: guarda o que foi criado e devolve o que foi lido. */
function projetoFalso(falhas: FalhasSimuladas = {}) {
  const criados = new Map<string, RegistroEncontrado & { tipo: string }>();
  const contadores = { usuario: 0, organizacao: 0, membership: 0 };
  let exclusoes = 0;
  let proximoId = 1;
  const ordemDeExclusao: string[] = [];

  for (const existente of falhas.jaExistentes ?? []) {
    criados.set(existente.identificador, { ...existente, tipo: inferirTipo(existente.identificador) });
  }

  function inferirTipo(identificador: string): string {
    if (identificador.includes('@') && identificador.split('@').length > 2) return 'membership';
    return identificador.includes('@') ? 'usuario' : 'organizacao';
  }

  function escrever(tipo: 'usuario' | 'organizacao' | 'membership', identificador: string): EscritaNoProjeto {
    const indice = contadores[tipo];
    contadores[tipo] += 1;
    if (falhas.escritaFalhaEm?.tipo === tipo && falhas.escritaFalhaEm.indice === indice) {
      return { _tag: 'FalhaDeEscrita', causa: `falha simulada em ${tipo}[${indice}]` };
    }
    const id = `id-${proximoId++}`;
    criados.set(identificador, { identificador, id, tipo });
    return { _tag: 'Escrito', id };
  }

  function ler(recurso: 'usuarios' | 'organizacoes' | 'memberships', tipo: string): LeituraDoProjeto {
    if (falhas.leituraFalhaEm === recurso) {
      return { _tag: 'FalhaDeLeitura', recurso, causa: 'falha simulada de leitura' };
    }
    return {
      _tag: 'Lido',
      registros: [...criados.values()].filter((c) => c.tipo === tipo).map(({ identificador, id }) => ({ identificador, id })),
    };
  }

  function apagar(id: string): ExclusaoNoProjeto {
    exclusoes += 1;
    if (falhas.exclusaoFalhaEm === exclusoes - 1) {
      return { _tag: 'FalhaDeExclusao', causa: 'falha simulada de exclusão' };
    }
    for (const [chave, valor] of criados) {
      if (valor.id === id) {
        // A ordem em que o projeto foi de fato modificado. Sem isto, "apagou o
        // vínculo antes da organização" só pode ser afirmado sobre o **plano**,
        // e plano não é execução.
        ordemDeExclusao.push(valor.identificador);
        criados.delete(chave);
      }
    }
    return { _tag: 'Excluido' };
  }

  const porta: PortaDoProjeto = {
    criarUsuario: async (email) => escrever('usuario', email),
    criarOrganizacao: async (slug) => escrever('organizacao', slug),
    criarMembership: async (organizacaoId, userId) => {
      const org = [...criados.values()].find((c) => c.id === organizacaoId);
      const usuario = [...criados.values()].find((c) => c.id === userId);
      return escrever('membership', `${usuario?.identificador ?? '?'}@${org?.identificador ?? '?'}`);
    },
    lerUsuariosDaExecucao: async () => ler('usuarios', 'usuario'),
    lerOrganizacoesDaExecucao: async () => ler('organizacoes', 'organizacao'),
    lerMembershipsDaExecucao: async () => ler('memberships', 'membership'),
    apagarUsuario: async (id) => apagar(id),
    apagarOrganizacao: async (id) => apagar(id),
    apagarMembership: async (id) => apagar(id),
  };

  return { porta, criados, ordemDeExclusao };
}

/** Disco em memória: guarda a última gravação do diário. */
function discoFalso() {
  const gravacoes: string[] = [];
  return {
    persistir: (conteudo: string) => { gravacoes.push(conteudo); },
    gravacoes,
    ultimo: (): DiarioDeExecucao => JSON.parse(gravacoes.at(-1)!) as DiarioDeExecucao,
  };
}

const manifesto = () => buildSeedManifest({ runId: RUN });

describe('o seed grava o diário antes e durante as escritas', () => {
  it('o plano vai a disco antes da primeira escrita', async () => {
    const disco = discoFalso();
    const { porta } = projetoFalso();
    const criarOrganizacao = vi.fn(porta.criarOrganizacao);

    await executarSeed({
      porta: { ...porta, criarOrganizacao },
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: disco.persistir,
    });

    // A primeira gravação é o plano vazio, e ela acontece antes de qualquer
    // chamada de escrita.
    const primeiro = JSON.parse(disco.gravacoes[0]!) as DiarioDeExecucao;
    expect(primeiro.concluidas).toEqual([]);
    expect(primeiro.plano.operacoes.length).toBeGreaterThan(0);
    expect(criarOrganizacao).toHaveBeenCalled();
  });

  it('cada operação concluída é gravada na hora', async () => {
    const disco = discoFalso();
    const { porta } = projetoFalso();

    const { diario } = await executarSeed({
      porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    // 1 gravação do plano + uma por operação **do seed**, que hoje são 15. As
    // outras três operações do plano são criadas pelas **specs** durante os
    // testes — a organização da spec e os dois vínculos —, previstas para a
    // limpeza alcançá-las e nunca escritas pelo seed. Por isso a contagem sai
    // do filtro `criadoPor === 'seed'`, e não de um número escrito à mão.
    const criadasPeloSeed = diario.plano.operacoes.filter((o) => o.criadoPor === 'seed').length;
    expect(disco.gravacoes).toHaveLength(1 + criadasPeloSeed);
    expect(disco.ultimo().concluidas).toHaveLength(criadasPeloSeed);
  });

  it('escrita que falha no meio deixa o diário com tudo o que já foi criado', async () => {
    // É o cenário que motivou o diário: interromper no meio não pode apagar o
    // rastro do que já existe no projeto.
    const disco = discoFalso();
    const { porta } = projetoFalso({ escritaFalhaEm: { tipo: 'usuario', indice: 2 } });

    await expect(executarSeed({
      porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    })).rejects.toThrow(/Falha ao criar o usuário/u);

    const diario = disco.ultimo();
    // 3 organizações + 2 usuários + os 2 memberships deles: o laço cria o
    // membership logo depois de cada usuário, então a falha no terceiro usuário
    // deixa **sete** registros gravados.
    expect(diario.concluidas).toHaveLength(7);
    expect(lerDiario(diario, { projetoRef: PROJETO, runId: RUN })._tag).toBe('DiarioValido');
  });
});

describe('a retomada não destrói o diário existente', () => {
  it('o diário de uma execução interrompida é preservado, não sobrescrito', async () => {
    // O defeito: a retomada montava plano novo e gravava por cima, apagando o
    // registro do que já tinha sido criado — antes mesmo de ler o projeto.
    const disco = discoFalso();
    const primeiroProjeto = projetoFalso({ escritaFalhaEm: { tipo: 'usuario', indice: 2 } });

    await expect(executarSeed({
      porta: primeiroProjeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    })).rejects.toThrow();
    const diarioParcial = disco.ultimo();
    expect(diarioParcial.concluidas).toHaveLength(7);

    const discoRetomada = discoFalso();
    const { diario } = await executarSeed({
      porta: primeiroProjeto.porta,
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: discoRetomada.persistir,
      diarioExistente: diarioParcial,
    });

    // A primeira gravação da retomada já traz o que existia — nunca um vazio.
    const primeiraDaRetomada = JSON.parse(discoRetomada.gravacoes[0]!) as DiarioDeExecucao;
    expect(primeiraDaRetomada.concluidas).toHaveLength(7);
    expect(diario.concluidas).toHaveLength(
      diario.plano.operacoes.filter((o) => o.criadoPor === 'seed').length,
    );
  });

  it('reconcilia usuários, organizações e memberships — não só organizações', async () => {
    // Reconciliar só organizações deixava o seed tentar recriar usuário com
    // e-mail já existente, e falhar por conta própria.
    const disco = discoFalso();
    const plano = planejarExecucao(manifesto(), PROJETO);
    const jaExistentes = plano.operacoes.map((o, i) => ({ identificador: o.identificador, id: `pre-${i}` }));
    const { porta } = projetoFalso({ jaExistentes });

    const { recuperadas, diario } = await executarSeed({
      porta,
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: disco.persistir,
      diarioExistente: { plano, concluidas: [] },
    });

    expect(recuperadas).toBe(plano.operacoes.length);
    expect(diario.concluidas.map((c) => c.idReal)).toEqual(jaExistentes.map((j) => j.id));
  });

  it('falha de leitura aborta a retomada em vez de duplicar registros', async () => {
    const disco = discoFalso();
    const plano = planejarExecucao(manifesto(), PROJETO);
    const { porta } = projetoFalso({ leituraFalhaEm: 'usuarios' });

    await expect(executarSeed({
      porta,
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: disco.persistir,
      diarioExistente: { plano, concluidas: [] },
    })).rejects.toThrow(/Retomada abortada: falha ao ler usuarios/u);
  });
});

describe('a limpeza distingue falha de leitura de registro ausente', () => {
  async function semear() {
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });
    return { projeto, diario };
  }

  it.each(['usuarios', 'organizacoes', 'memberships'] as const)(
    'falha ao ler %s aborta: erro de leitura não é ausência',
    async (recurso) => {
      // O defeito: `catch → continue` fazia falha de rede parecer registro já
      // removido, e a limpeza declarava sucesso deixando dado no projeto.
      const { diario } = await semear();
      const { porta } = projetoFalso({ leituraFalhaEm: recurso });

      await expect(executarLimpeza(porta, diario, { simular: false }))
        .rejects.toThrow(new RegExp(`Limpeza abortada: falha ao ler ${recurso}`, "u"));
    },
  );

  it('apaga tudo o que a execução criou, e nada além', async () => {
    const { projeto, diario } = await semear();
    projeto.criados.set('cliente-de-verdade@empresa.com', {
      identificador: 'cliente-de-verdade@empresa.com', id: 'id-real', tipo: 'usuario',
    });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: false });

    // Os registros que as specs criam não existem neste cenário — a suíte não
    // rodou —, então o que sai são os 15 do seed. O plano os conhece mesmo
    // assim, e eles entram como "já removidos".
    expect(resultado.removidos).toBe(15);
    expect([...projeto.criados.keys()]).toEqual(['cliente-de-verdade@empresa.com']);
  });

  it('a segunda limpeza termina em sucesso, sem nada a apagar', async () => {
    const { projeto, diario } = await semear();
    await executarLimpeza(projeto.porta, diario, { simular: false });

    const segunda = await executarLimpeza(projeto.porta, diario, { simular: false });

    expect(segunda.removidos).toBe(0);
    expect(segunda.plano.jaRemovidas).toHaveLength(diario.plano.operacoes.length);
    expect(segunda.plano.naoRegistradas).toEqual([]);
  });

  it('exclusão que falha no meio manda repetir com o mesmo diário', async () => {
    // Semeia num projeto cuja terceira exclusão falha.
    const comFalha = projetoFalso({ exclusaoFalhaEm: 2 });
    const semeado = await executarSeed({
      porta: comFalha.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: discoFalso().persistir,
    });

    await expect(executarLimpeza(comFalha.porta, semeado.diario, { simular: false }))
      .rejects.toThrow(/rode a limpeza de novo com o mesmo diário/u);
  });

  it('simular não apaga nada e descreve o que apagaria', async () => {
    const { projeto, diario } = await semear();

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: true });

    expect(resultado.simulado).toBe(true);
    expect(resultado.removidos).toBe(0);
    expect(projeto.criados.size).toBe(15);
    for (const aprovada of resultado.plano.aprovadas) {
      expect(resultado.simulacao).toContain(aprovada.identificador);
    }
  });
});

describe('órfãos são relatados sobre o que o projeto tem, não sobre o que o diário conhece', () => {
  it('registro criado pela execução e ausente do diário aparece como órfão', async () => {
    // O defeito: os órfãos eram procurados dentro da lista que o próprio
    // diário produzia, então um registro que o diário não conhecia jamais
    // apareceria. É justamente esse que interessa.
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    projeto.criados.set(`orbita-e2e-${RUN}-sobra@e2e.orbita.test`, {
      identificador: `orbita-e2e-${RUN}-sobra@e2e.orbita.test`, id: 'id-sobra', tipo: 'usuario',
    });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: true });

    expect(resultado.orfaos.map((o) => o.id)).toEqual(['id-sobra']);
  });

  it('órfão de outra execução não é relatado', async () => {
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    projeto.criados.set('orbita-e2e-run-9-outro@e2e.orbita.test', {
      identificador: 'orbita-e2e-run-9-outro@e2e.orbita.test', id: 'id-9', tipo: 'usuario',
    });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: true });

    expect(resultado.orfaos).toEqual([]);
  });
});

describe('a gravação local falha depois de a criação remota concluir', () => {
  /** Disco que lança na enésima gravação, como um disco cheio faria. */
  function discoQueFalhaNa(gravacaoQueFalha: number) {
    const gravacoes: string[] = [];
    return {
      gravacoes,
      persistir: (conteudo: string) => {
        if (gravacoes.length === gravacaoQueFalha) {
          throw new Error('falha simulada ao gravar o diário');
        }
        gravacoes.push(conteudo);
      },
      ultimo: (): DiarioDeExecucao => JSON.parse(gravacoes.at(-1)!) as DiarioDeExecucao,
    };
  }

  it('o registro remoto existe e o diário não o tem — e a retomada o recupera', async () => {
    // O cenário exato: a organização foi criada no projeto, e o processo morreu
    // gravando o diário. O disco anterior nunca falhava, então isso nunca era
    // exercitado.
    const projeto = projetoFalso();
    const disco = discoQueFalhaNa(1); // 0 = plano, 1 = primeira conclusão

    await expect(executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    })).rejects.toThrow(/falha simulada ao gravar o diário/u);

    // O projeto tem a organização; o diário gravado não sabe dela.
    const diarioNoDisco = disco.ultimo();
    expect(diarioNoDisco.concluidas).toEqual([]);
    expect(projeto.criados.size).toBe(1);

    // Retomada: reconcilia, adota o id que existe, e termina o resto.
    const discoRetomada = discoFalso();
    const { diario, recuperadas } = await executarSeed({
      porta: projeto.porta,
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: discoRetomada.persistir,
      diarioExistente: diarioNoDisco,
    });

    expect(recuperadas).toBe(1);
    const criadasPeloSeed = diario.plano.operacoes.filter((o) => o.criadoPor === 'seed').length;
    expect(diario.concluidas).toHaveLength(criadasPeloSeed);
    // E o projeto não ganhou organização duplicada.
    const slugs = [...projeto.criados.values()].filter((c) => c.tipo === 'organizacao');
    expect(slugs).toHaveLength(3);
  });

  it('sem a retomada, a limpeza adota o registro e o apaga — em vez de escondê-lo', async () => {
    const projeto = projetoFalso();
    const disco = discoQueFalhaNa(1);

    await expect(executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    })).rejects.toThrow();

    const diarioNoDisco = disco.ultimo();
    expect(diarioNoDisco.concluidas).toEqual([]);
    const orgCriada = [...projeto.criados.values()].find((c) => c.tipo === 'organizacao')!;

    const resultado = await executarLimpeza(projeto.porta, diarioNoDisco, { simular: false });

    // Antes: a operação sem conclusão caía em `jaRemovidas` e sumia do
    // relatório de órfãos — existia no projeto e ninguém via. Agora a
    // reconciliação da limpeza adota o id real e ela é de fato apagada, que é
    // um desfecho melhor que apenas relatá-la.
    expect(resultado.plano.aprovadas.map((a) => a.identificador)).toContain(orgCriada.identificador);
    expect(projeto.criados.has(orgCriada.identificador)).toBe(false);
  });
});

describe('a organização que a spec cria é alcançada pela limpeza', () => {
  it('criada durante os testes, sem passar pelo seed, ainda assim é apagada', async () => {
    // Ela não está em `concluidas` — o seed não a cria. A reconciliação antes
    // da limpeza adota o id real, e aí ela vira exclusão aprovada. Sem isso,
    // sobrava no projeto a cada execução.
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    const slugDaSpec = `orbita-e2e-${RUN}-spec-created-org`;
    projeto.criados.set(slugDaSpec, { identificador: slugDaSpec, id: 'id-spec-org', tipo: 'organizacao' });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: false });

    expect(resultado.plano.aprovadas.map((a) => a.identificador)).toContain(slugDaSpec);
    expect(projeto.criados.has(slugDaSpec)).toBe(false);
  });

  it('quando a spec não roda, a organização dela é apenas "já removida"', async () => {
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: true });

    // Três registros de spec: a organização que ela cria, o vínculo de dono que
    // nasce junto, e o vínculo do convite aceito. Nenhum existe quando a suíte
    // não roda — e todos são "já removidos", não erro.
    expect(resultado.plano.jaRemovidas.map((o) => o.criadoPor)).toEqual(['spec', 'spec', 'spec']);
    expect(resultado.plano.naoRegistradas).toEqual([]);
  });
});

describe('divergência entre diário e projeto interrompe', () => {
  it('a retomada para quando o id no projeto não é o do diário', async () => {
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    // Alguém apagou e recriou a organização: mesmo slug, id novo.
    const primeira = diario.plano.operacoes.find((o) => o.tipo === 'organizacao')!;
    projeto.criados.set(primeira.identificador, {
      identificador: primeira.identificador, id: 'id-recriado', tipo: 'organizacao',
    });

    await expect(executarSeed({
      porta: projeto.porta,
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: discoFalso().persistir,
      diarioExistente: diario,
    })).rejects.toThrow(/Retomada abortada: 1 registro\(s\) com id diferente/u);
  });

  it('a limpeza também para, e o diário é preservado', async () => {
    const disco = discoFalso();
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: disco.persistir,
    });

    const primeira = diario.plano.operacoes.find((o) => o.tipo === 'organizacao')!;
    projeto.criados.set(primeira.identificador, {
      identificador: primeira.identificador, id: 'id-recriado', tipo: 'organizacao',
    });

    await expect(executarLimpeza(projeto.porta, diario, { simular: false }))
      .rejects.toThrow(/Limpeza abortada: 1 registro\(s\) com id diferente/u);
    // Nada foi apagado.
    expect(projeto.criados.size).toBeGreaterThan(0);
  });
});

describe('conclusão registrada mas ausente do projeto: as duas políticas divergem', () => {
  /** Semeia tudo e depois apaga do projeto o registro do tipo pedido. */
  async function semearEApagar(tipo: 'usuario' | 'organizacao' | 'membership') {
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: discoFalso().persistir,
    });
    const alvo = [...projeto.criados.values()].find((c) => c.tipo === tipo)!;
    projeto.criados.delete(alvo.identificador);
    return { projeto, diario, alvo };
  }

  it.each(['usuario', 'organizacao', 'membership'] as const)(
    'a retomada aborta quando o %s concluído sumiu do projeto',
    async (tipo) => {
      // O defeito: só o id divergente era detectado. Ausência passava batida, e
      // a retomada terminava "com sucesso" deixando o registro faltando — ou
      // criava membership com um id que já não existe.
      const { projeto, diario, alvo } = await semearEApagar(tipo);

      const retomar = () => executarSeed({
        porta: projeto.porta,
        manifest: manifesto(),
        projetoRef: PROJETO,
        persistir: discoFalso().persistir,
        diarioExistente: diario,
      });

      await expect(retomar()).rejects.toThrow(
        /Retomada abortada: 1 registro\(s\) que o diário dá por concluídos não existem/u,
      );

      // A mensagem nomeia o registro, para o reparo ser possível.
      const erro = await retomar().then(() => null, (e: unknown) => e as Error);
      expect(erro?.message).toContain(alvo.identificador);
    },
  );

  it.each(['usuario', 'organizacao', 'membership'] as const)(
    'a limpeza trata o %s ausente como já removido, e conclui',
    async (tipo) => {
      // Mesma ausência, política oposta: aqui é o caso normal.
      const { projeto, diario, alvo } = await semearEApagar(tipo);

      const resultado = await executarLimpeza(projeto.porta, diario, { simular: false });

      expect(resultado.plano.jaRemovidas.map((o) => o.identificador)).toContain(alvo.identificador);
      expect(resultado.plano.recusadas).toEqual([]);
    },
  );

  it('a retomada não repara sozinha: o diário continua com a conclusão antiga', async () => {
    const { projeto, diario } = await semearEApagar('organizacao');
    const disco = discoFalso();

    await expect(executarSeed({
      porta: projeto.porta,
      manifest: manifesto(),
      projetoRef: PROJETO,
      persistir: disco.persistir,
      diarioExistente: diario,
    })).rejects.toThrow();

    // A única gravação foi o diário recebido, intacto. Reparar automaticamente
    // apagaria a prova do que foi criado.
    expect(disco.gravacoes).toHaveLength(1);
    expect(disco.ultimo().concluidas).toHaveLength(diario.concluidas.length);
  });
});

describe('a adoção pelo identificador natural é restrita', () => {
  const slugDaSpec = `orbita-e2e-${RUN}-spec-created-org`;

  async function semearComOrgDaSpec() {
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: discoFalso().persistir,
    });
    // A suíte criou a organização dela durante os testes.
    projeto.criados.set(slugDaSpec, { identificador: slugDaSpec, id: 'id-spec-org', tipo: 'organizacao' });
    return { projeto, diario };
  }

  it('diário completo: a única adoção é a organização que a spec criou', async () => {
    // Todas as operações do seed têm conclusão gravada, então não há nada do
    // seed a adotar. A da spec é adotada pelo identificador determinístico —
    // o seed nunca teria id dela.
    const { projeto, diario } = await semearComOrgDaSpec();

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: true });

    expect(resultado.adotadas).toEqual([
      expect.objectContaining({ identificador: slugDaSpec, idAdotado: 'id-spec-org', criadoPor: 'spec' }),
    ]);
  });

  it('estado de recuperação: adota também o registro do seed que ficou sem conclusão', async () => {
    // Gravação que falhou depois da criação remota. Aqui a adoção do registro
    // do seed é legítima: ele existe no projeto e o diário não soube.
    const { projeto, diario } = await semearComOrgDaSpec();
    const semConclusao = diario.plano.operacoes.find((o) => o.chave === 'persona:owner-a')!;
    const idNoProjeto = diario.concluidas.find((c) => c.chave === semConclusao.chave)!.idReal;
    const diarioIncompleto = {
      ...diario,
      concluidas: diario.concluidas.filter((c) => c.chave !== semConclusao.chave),
    };

    const resultado = await executarLimpeza(projeto.porta, diarioIncompleto, { simular: true });

    expect(resultado.adotadas).toEqual([
      expect.objectContaining({ identificador: semConclusao.identificador, idAdotado: idNoProjeto, criadoPor: 'seed' }),
      expect.objectContaining({ identificador: slugDaSpec, criadoPor: 'spec' }),
    ]);
  });

  it('a organização da spec não é adotada quando não existe no projeto', async () => {
    // O outro lado: adotar sem o registro existir seria inventar id.
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: discoFalso().persistir,
    });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: true });

    expect(resultado.adotadas).toEqual([]);
    // Três registros de spec: a organização que ela cria, o vínculo de dono que
    // nasce junto, e o vínculo do convite aceito. Nenhum existe quando a suíte
    // não roda — e todos são "já removidos", não erro.
    expect(resultado.plano.jaRemovidas.map((o) => o.criadoPor)).toEqual(['spec', 'spec', 'spec']);
  });
});

/**
 * Ticket 23 — a limpeza **executada**, e não só planejada.
 *
 * A primeira regressão deste ticket chamava `reconciliar` e `planejarLimpeza`
 * direto, e dizia atravessar a limpeza. Não atravessava: não passava por
 * `executarLimpeza`, não tocava a porta de exclusão, e o caso chamado "depois
 * da limpeza" rodava **antes** de qualquer remoção — `relatarOrfaos(...) === []`
 * ali significa apenas que o plano conhece os registros.
 *
 * É a família 1 mais uma vez, e desta vez dentro da prova: as duas metades
 * certas — o plano prevê, a limpeza apaga — e a ligação entre elas não medida.
 *
 * Aqui a suíte é simulada de verdade: os registros que as specs criariam são
 * injetados no projeto falso, `executarLimpeza` roda sem `simular`, e o que se
 * cobra é o **estado do projeto depois**.
 */
describe('a limpeza executada apaga os registros que as specs criaram', () => {
  /** Semeia normalmente, como `e2e:seed` faria. */
  async function semearNoProjeto() {
    const projeto = projetoFalso();
    const { diario } = await executarSeed({
      porta: projeto.porta, manifest: manifesto(), projetoRef: PROJETO, persistir: discoFalso().persistir,
    });
    return { projeto, diario };
  }

  /** O que a suíte teria criado ao rodar: os dois vínculos e a organização da spec. */
  function injetarRegistrosDasSpecs(projeto: ReturnType<typeof projetoFalso>, diario: DiarioDeExecucao) {
    const daSpec = diario.plano.operacoes.filter((o) => o.criadoPor === 'spec');
    for (const [i, operacao] of daSpec.entries()) {
      projeto.criados.set(operacao.identificador, {
        identificador: operacao.identificador,
        // Ids **remotos**: não são os do diário, porque o seed não criou estes
        // registros. Adotá-los é exatamente o que a reconciliação precisa fazer.
        id: `id-remoto-da-spec-${i}`,
        tipo: operacao.tipo,
      });
    }
    return daSpec;
  }

  it('adota os vínculos pelos ids remotos, apaga cada um antes da sua organização, e não deixa resíduo', async () => {
    const { projeto, diario } = await semearNoProjeto();
    const daSpec = injetarRegistrosDasSpecs(projeto, diario);
    // Um registro que não é desta execução: ele não pode ser tocado.
    projeto.criados.set('cliente-de-verdade@empresa.com', {
      identificador: 'cliente-de-verdade@empresa.com', id: 'id-real', tipo: 'usuario',
    });

    const resultado = await executarLimpeza(projeto.porta, diario, { simular: false });

    // 1. Adoção pelos ids remotos — os dois vínculos que as specs criam.
    const vinculosDaSpec = daSpec.filter((o) => o.tipo === 'membership');
    expect(vinculosDaSpec).toHaveLength(2);
    for (const vinculo of vinculosDaSpec) {
      const adotada = resultado.adotadas.find((a) => a.identificador === vinculo.identificador);
      expect(adotada, `o vínculo ${vinculo.chave} não foi adotado`).toBeDefined();
      expect(adotada!.idAdotado).toMatch(/^id-remoto-da-spec-/u);
    }

    // 2. Cada vínculo saiu **antes** da organização dele, no projeto de verdade.
    const posicao = (identificador: string) => projeto.ordemDeExclusao.indexOf(identificador);
    for (const vinculo of vinculosDaSpec) {
      const slugDaOrganizacao = vinculo.identificador.slice(vinculo.identificador.lastIndexOf('@') + 1);
      expect(posicao(vinculo.identificador)).toBeGreaterThanOrEqual(0);
      expect(posicao(vinculo.identificador)).toBeLessThan(posicao(slugDaOrganizacao));
    }

    // 3. Nenhum dos registros das specs sobrou.
    for (const operacao of daSpec) {
      expect([...projeto.criados.keys()]).not.toContain(operacao.identificador);
    }

    // 4. E o que é de fora da execução ficou intacto.
    expect([...projeto.criados.keys()]).toEqual(['cliente-de-verdade@empresa.com']);
  });

  it('a segunda limpeza não tem o que apagar, e termina em sucesso', async () => {
    const { projeto, diario } = await semearNoProjeto();
    injetarRegistrosDasSpecs(projeto, diario);

    await executarLimpeza(projeto.porta, diario, { simular: false });
    const segunda = await executarLimpeza(projeto.porta, diario, { simular: false });

    expect(segunda.removidos).toBe(0);
    expect(segunda.plano.aprovadas).toEqual([]);
    expect(projeto.criados.size).toBe(0);
  });
});
