import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ErroDeTokenDoBling,
  TokenDoBlingOrquestrado,
  lerCredenciais,
  type ArmazenamentoDeCredenciais,
  type ResultadoDaConexao,
  type ResultadoDoLock,
  type TrocaDeToken,
} from './blingToken';
import type { BlingRefreshTokenInput } from './blingOAuth';

/**
 * Ticket 31 — obtenção e renovação do token.
 *
 * **Nenhum caso deste arquivo toca a rede** — e a afirmação para por aqui: o
 * guarda abaixo é local a esta suíte, e não um bloqueio global das 153. A
 * versão anterior deste arquivo dublava o
 * armazenamento e deixava a troca OAuth entrar por import direto: um dos casos
 * fazia `POST` de verdade em `api.bling.com.br/Api/v3/oauth/token`, e o
 * `.catch()` que eu tinha posto só engolia a resposta — a requisição saía. O
 * guarda de `fetch` existe para isso não voltar em silêncio.
 *
 * O armazenamento e a troca são dublados **por inteiro**, nunca campo a campo.
 */

interface Estado {
  conexao: ResultadoDaConexao;
  credenciais: unknown;
  lock: ResultadoDoLock;
}

/** Rejeições programáveis, uma por porta. */
type PortaQueRejeita = 'acharConexaoId' | 'ler' | 'gravar' | 'tentarLock' | 'soltarLock';

function armazenamentoFalso(inicial: Partial<Estado> = {}) {
  const estado: Estado = {
    conexao: inicial.conexao ?? { _tag: 'Encontrada', conexaoId: 'conexao-1' },
    credenciais: inicial.credenciais ?? { access_token: 'token-valido' },
    lock: inicial.lock ?? { _tag: 'Adquirido' },
  };

  const rejeicoes = new Map<PortaQueRejeita, unknown>();

  const chamadas = { acharConexaoId: 0, ler: 0, tentarLock: 0, soltarLock: 0 };
  const atrasos = { acharConexaoId: 0, ler: 0 };
  const gravacoes: Array<{ organizacaoId: string; conexaoId: string; credenciais: Record<string, unknown> }> = [];

  const armazenamento: ArmazenamentoDeCredenciais = {
    acharConexaoId: async () => {
      chamadas.acharConexaoId += 1;
      if (atrasos.acharConexaoId) await new Promise((r) => setTimeout(r, atrasos.acharConexaoId));
      talvezRejeitar('acharConexaoId');
      return estado.conexao;
    },
    ler: async () => {
      chamadas.ler += 1;
      if (atrasos.ler) await new Promise((r) => setTimeout(r, atrasos.ler));
      talvezRejeitar('ler');
      return estado.credenciais;
    },
    gravar: async (organizacaoId, conexaoId, credenciais) => {
      talvezRejeitar('gravar');
      gravacoes.push({ organizacaoId, conexaoId, credenciais });
      estado.credenciais = credenciais;
    },
    tentarLock: async () => {
      chamadas.tentarLock += 1;
      talvezRejeitar('tentarLock');
      return estado.lock;
    },
    soltarLock: async () => {
      chamadas.soltarLock += 1;
      talvezRejeitar('soltarLock');
    },
  };

  function talvezRejeitar(porta: PortaQueRejeita): void {
    if (rejeicoes.has(porta)) throw rejeicoes.get(porta);
  }

  return {
    armazenamento,
    chamadas,
    atrasos,
    estado,
    gravacoes,
    fazerRejeitar: (porta: PortaQueRejeita, causa: unknown) => rejeicoes.set(porta, causa),
  };
}

const emMs = (delta: number) => new Date(Date.now() + delta).toISOString();

const CREDENCIAL_COMPLETA = {
  access_token: 'token-vencido',
  client_id: 'id-do-app',
  client_secret: 'segredo-do-app',
  refresh_token: 'refresh-antigo',
  token_expires_at: emMs(-60_000),
};

/** Troca OAuth bem-sucedida que **guarda a entrada recebida**. */
function trocaQueRegistra() {
  const entradas: BlingRefreshTokenInput[] = [];
  const trocar: TrocaDeToken = async (entrada) => {
    entradas.push(entrada);
    return {
      _tag: 'BlingOAuthTokenExchangeSucceeded',
      access_token: 'token-novinho',
      refresh_token: 'refresh-rotacionado',
      expires_in: 3600,
    };
  };
  return { trocar, entradas };
}

/** Troca OAuth bem-sucedida, com refresh token **rotacionado**. */
const trocaBemSucedida: TrocaDeToken = async () => ({
  _tag: 'BlingOAuthTokenExchangeSucceeded',
  access_token: 'token-novinho',
  refresh_token: 'refresh-rotacionado',
  expires_in: 3600,
});

let fetchOriginal: typeof globalThis.fetch;
let saidasDeRede: string[];

beforeEach(() => {
  saidasDeRede = [];
  fetchOriginal = globalThis.fetch;
  // SAFETY: o guarda só precisa registrar o destino e rejeitar; ele nunca
  // devolve uma `Response`, então a assinatura completa de `fetch` não é
  // exercitada. O original é restaurado no `afterEach`.
  globalThis.fetch = (async (entrada: unknown) => {
    saidasDeRede.push(String(entrada));
    throw new Error('a suíte de token não pode sair na rede');
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  expect(saidasDeRede).toEqual([]);
});

describe('lerCredenciais', () => {
  it('lê os campos que interessam e descarta o resto', () => {
    expect(lerCredenciais({ access_token: 'abc', lixo: 1 })).toEqual({ access_token: 'abc' });
  });

  it('recusa o que não tem a forma esperada, em vez de afirmar', () => {
    expect(lerCredenciais({ access_token: 42 })).toBeNull();
    expect(lerCredenciais(null)).toBeNull();
    expect(lerCredenciais('texto')).toBeNull();
  });

  it('recusa validade que não é data parseável', () => {
    // Antes, `new Date('ontem').getTime()` dava `NaN`, `agora() >= NaN` dava
    // `false`, e um token com validade ilegível passava por vigente **para
    // sempre**. Falha silenciosa, do tipo que só aparece como "o Bling parou".
    expect(lerCredenciais({ access_token: 'abc', token_expires_at: 'ontem' })).toBeNull();
    expect(lerCredenciais({ access_token: 'abc', token_expires_at: emMs(60_000) })).not.toBeNull();
  });
});

describe('obter', () => {
  const criar = (armazenamento: ArmazenamentoDeCredenciais) =>
    new TokenDoBlingOrquestrado({ organizacaoId: 'org-1', armazenamento, trocarToken: trocaBemSucedida });

  it('devolve o token vigente sem disputar lock', async () => {
    const { armazenamento, chamadas } = armazenamentoFalso({
      credenciais: { access_token: 'token-valido', token_expires_at: emMs(60_000) },
    });

    expect(await criar(armazenamento).obter()).toBe('token-valido');
    expect(chamadas.tentarLock).toBe(0);
  });

  it('recusa quando não há conexão, com motivo nomeado', async () => {
    const { armazenamento } = armazenamentoFalso({ conexao: { _tag: 'SemConexao' } });

    await expect(criar(armazenamento).obter()).rejects.toMatchObject({ motivo: 'sem-conexao' });
  });

  it('recusa credencial em formato inesperado, sem confundir com "não conectado"', async () => {
    const { armazenamento } = armazenamentoFalso({ credenciais: { access_token: 42 } });

    await expect(criar(armazenamento).obter()).rejects.toMatchObject({ motivo: 'credencial-invalida' });
  });

  it('renova e devolve o token novo quando o vigente venceu', async () => {
    const { armazenamento, chamadas } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });

    expect(await criar(armazenamento).obter()).toBe('token-novinho');
    expect(chamadas.tentarLock).toBe(1);
  });

  it('não começa a ler o cofre quando a busca da conexão já consumiu o prazo', async () => {
    const { armazenamento, chamadas, atrasos } = armazenamentoFalso();
    atrasos.acharConexaoId = 80;

    const controle = new AbortController();
    setTimeout(() => controle.abort(new Error('prazo')), 20);

    await expect(criar(armazenamento).obter(controle.signal)).rejects.toThrow(/prazo/u);
    expect(chamadas.acharConexaoId).toBe(1);
    expect(chamadas.ler).toBe(0);
  });

  it('não começa a renovação quando a leitura do cofre já consumiu o prazo', async () => {
    const { armazenamento, chamadas, atrasos } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });
    atrasos.ler = 80;

    const controle = new AbortController();
    setTimeout(() => controle.abort(new Error('prazo')), 20);

    await expect(criar(armazenamento).obter(controle.signal)).rejects.toThrow(/prazo/u);
    expect(chamadas.ler).toBe(1);
    expect(chamadas.tentarLock).toBe(0);
  });
});

describe('renovar', () => {
  it('persiste no par organização/conexão certo e rotaciona o refresh', async () => {
    // A prova que faltava: antes nenhum caso chegava a uma renovação
    // bem-sucedida, porque a única que existia saía na rede e falhava.
    const { armazenamento, gravacoes, chamadas } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });
    const agora = () => 1_000_000;
    const oauth = trocaQueRegistra();

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      conexaoId: 'conexao-1',
      armazenamento,
      trocarToken: oauth.trocar,
      agora,
    });

    expect(await token.renovar()).toBe('token-novinho');

    // **A entrada entregue ao OAuth.** Antes o dublê ignorava os argumentos,
    // e uma regressão em `clientId`, `clientSecret` ou `refreshToken` passaria
    // sem ninguém notar — inclusive mandar o token novo no lugar do antigo.
    expect(oauth.entradas).toEqual([{
      clientId: 'id-do-app',
      clientSecret: 'segredo-do-app',
      refreshToken: 'refresh-antigo',
    }]);

    expect(gravacoes).toHaveLength(1);
    const gravacao = gravacoes[0];
    if (!gravacao) throw new Error('esperava uma gravação');

    expect(gravacao.organizacaoId).toBe('org-1');
    expect(gravacao.conexaoId).toBe('conexao-1');
    expect(gravacao.credenciais).toEqual({
      client_id: 'id-do-app',
      client_secret: 'segredo-do-app',
      access_token: 'token-novinho',
      // O Bling rotaciona o refresh token; guardar o antigo faria a próxima
      // renovação falhar com `invalid_grant` e a conta cair sozinha.
      refresh_token: 'refresh-rotacionado',
      token_expires_at: new Date(agora() + 3600 * 1000).toISOString(),
    });

    expect(chamadas.soltarLock).toBe(1);
  });

  it('solta o lock também quando a troca é recusada', async () => {
    // Um lock retido depois de um erro trava a renovação de todo mundo até o
    // timeout do banco.
    const { armazenamento, chamadas, gravacoes } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: async () => ({ _tag: 'BlingOAuthTokenExchangeFailed', reason: 'http', status: 400 }),
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'troca-recusada' });
    expect(chamadas.soltarLock).toBe(1);
    expect(gravacoes).toHaveLength(0);
  });

  it('falha ao disputar o lock não vira "outro processo está renovando"', async () => {
    // Tratar as duas igual mandava o chamador esperar meio minuto por uma
    // renovação que ninguém estava fazendo.
    const { armazenamento, chamadas } = armazenamentoFalso({
      credenciais: CREDENCIAL_COMPLETA,
      lock: { _tag: 'Indisponivel', causa: new Error('banco fora') },
    });

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'lock-indisponivel' });
    // Não esperou ninguém, e não soltou lock que não tinha.
    expect(chamadas.ler).toBe(0);
    expect(chamadas.soltarLock).toBe(0);
  });

  it('lock ocupado: espera o token que o outro processo publicar', async () => {
    const { armazenamento, estado, chamadas } = armazenamentoFalso({
      credenciais: { access_token: 'antigo', token_expires_at: emMs(-1) },
      lock: { _tag: 'Ocupado' },
    });

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
      dormir: async () => {
        estado.credenciais = { access_token: 'publicado-pelo-outro', token_expires_at: emMs(60_000) };
      },
    });

    expect(await token.renovar()).toBe('publicado-pelo-outro');
    // Não soltou um lock que pertence ao outro processo.
    expect(chamadas.soltarLock).toBe(0);
  });

  it('lock ocupado: desiste depois das tentativas, em vez de esperar para sempre', async () => {
    const { armazenamento } = armazenamentoFalso({
      credenciais: { access_token: 'antigo', token_expires_at: emMs(-1) },
      lock: { _tag: 'Ocupado' },
    });

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
      dormir: async () => {},
      tentativasDeEspera: 3,
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'concorrencia-expirada' });
  });

  it('solta o lock quando a gravação falha, e a falha da gravação prevalece', async () => {
    const { armazenamento, chamadas, fazerRejeitar } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });
    fazerRejeitar('gravar', new Error('cofre fora do ar'));

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'armazenamento-falhou' });
    expect(chamadas.soltarLock).toBe(1);
  });

  it('a falha da operação prevalece sobre a falha ao soltar o lock', async () => {
    // Um `finally` com `await` cru deixaria a falha do unlock substituir a da
    // renovação, e o chamador receberia "não consegui soltar o lock" no lugar
    // da causa raiz.
    const { armazenamento, fazerRejeitar } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });
    fazerRejeitar('soltarLock', new Error('unlock recusado'));

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: async () => ({ _tag: 'BlingOAuthTokenExchangeFailed', reason: 'http', status: 400 }),
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'troca-recusada' });
  });

  it('falha ao soltar o lock aparece quando a renovação deu certo', async () => {
    // No caminho feliz não há causa raiz para preservar, e um unlock recusado
    // trava a renovação de todo mundo: ele precisa aparecer.
    const { armazenamento, fazerRejeitar } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });
    fazerRejeitar('soltarLock', new Error('unlock recusado'));

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'lock-indisponivel' });
  });
});

/**
 * O contrato dizia "a falha é sempre `ErroDeTokenDoBling`" e era maior que o
 * código: ele cobria os caminhos que o módulo **decide**, e qualquer rejeição de
 * porta — banco fora, cofre indisponível, rede — atravessava crua. O caso antigo
 * percorria só `sem-conexao`, então não notava.
 */
describe('rejeição de porta vira falha tipada', () => {
  const casos = [
    { porta: 'acharConexaoId', motivo: 'armazenamento-falhou' },
    { porta: 'ler', motivo: 'armazenamento-falhou' },
    { porta: 'tentarLock', motivo: 'lock-indisponivel' },
  ] as const;

  for (const caso of casos) {
    it(caso.porta + ' rejeitando vira ' + caso.motivo, async () => {
      const { armazenamento, fazerRejeitar } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });
      fazerRejeitar(caso.porta, new Error('infraestrutura fora'));

      const token = new TokenDoBlingOrquestrado({
        organizacaoId: 'org-1',
        armazenamento,
        trocarToken: trocaBemSucedida,
      });

      const erro: unknown = await token.renovar().catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ErroDeTokenDoBling);
      expect(erro).toMatchObject({ motivo: caso.motivo });
      // A causa original fica guardada para o log, sem ir para a mensagem.
      expect((erro as Error).cause).toBeInstanceOf(Error);
    });
  }

  it('a troca OAuth rejeitando vira troca-falhou, distinta de troca-recusada', async () => {
    // Recusa é o Bling dizendo não; rejeição é não ter conseguido perguntar.
    const { armazenamento } = armazenamentoFalso({ credenciais: CREDENCIAL_COMPLETA });

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: async () => { throw new Error('rede caiu'); },
    });

    await expect(token.renovar()).rejects.toMatchObject({ motivo: 'troca-falhou' });
  });

  it('falha de infraestrutura na busca da conexão não vira "sem conexão"', async () => {
    // Confundir as duas mandava o lojista reconectar uma conta que já estava
    // conectada, escondendo que o problema era do banco.
    const { armazenamento } = armazenamentoFalso({
      conexao: { _tag: 'Indisponivel', causa: new Error('banco fora') },
    });

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
    });

    await expect(token.obter()).rejects.toMatchObject({ motivo: 'armazenamento-falhou' });
  });
});

describe('o guarda de rede', () => {
  it('enxerga uma saída, para os outros casos não passarem por engano', async () => {
    await expect(fetch('https://exemplo.invalido')).rejects.toThrow(/não pode sair na rede/u);
    expect(saidasDeRede).toEqual(['https://exemplo.invalido']);
    // Limpa, senão o `afterEach` reprova este caso de propósito.
    saidasDeRede.length = 0;
  });
});
