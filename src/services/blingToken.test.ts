import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ErroDeTokenDoBling,
  TokenDoBlingOrquestrado,
  lerCredenciais,
  type ArmazenamentoDeCredenciais,
  type ResultadoDoLock,
  type TrocaDeToken,
} from './blingToken';

/**
 * Ticket 31 — obtenção e renovação do token.
 *
 * **Nada aqui toca a rede.** A versão anterior deste arquivo dublava o
 * armazenamento e deixava a troca OAuth entrar por import direto: um dos casos
 * fazia `POST` de verdade em `api.bling.com.br/Api/v3/oauth/token`, e o
 * `.catch()` que eu tinha posto só engolia a resposta — a requisição saía. O
 * guarda de `fetch` existe para isso não voltar em silêncio.
 *
 * O armazenamento e a troca são dublados **por inteiro**, nunca campo a campo.
 */

interface Estado {
  conexaoId: string | null;
  credenciais: unknown;
  lock: ResultadoDoLock;
}

function armazenamentoFalso(inicial: Partial<Estado> = {}) {
  const estado: Estado = {
    // `??` aqui apagaria o caso que interessa: `null` é "não há conexão", e não
    // "não informado".
    conexaoId: 'conexaoId' in inicial ? (inicial.conexaoId ?? null) : 'conexao-1',
    credenciais: inicial.credenciais ?? { access_token: 'token-valido' },
    lock: inicial.lock ?? { _tag: 'Adquirido' },
  };

  const chamadas = { acharConexaoId: 0, ler: 0, tentarLock: 0, soltarLock: 0 };
  const atrasos = { acharConexaoId: 0, ler: 0 };
  const gravacoes: Array<{ organizacaoId: string; conexaoId: string; credenciais: Record<string, unknown> }> = [];

  const armazenamento: ArmazenamentoDeCredenciais = {
    acharConexaoId: async () => {
      chamadas.acharConexaoId += 1;
      if (atrasos.acharConexaoId) await new Promise((r) => setTimeout(r, atrasos.acharConexaoId));
      return estado.conexaoId;
    },
    ler: async () => {
      chamadas.ler += 1;
      if (atrasos.ler) await new Promise((r) => setTimeout(r, atrasos.ler));
      return estado.credenciais;
    },
    gravar: async (organizacaoId, conexaoId, credenciais) => {
      gravacoes.push({ organizacaoId, conexaoId, credenciais });
      estado.credenciais = credenciais;
    },
    tentarLock: async () => {
      chamadas.tentarLock += 1;
      return estado.lock;
    },
    soltarLock: async () => {
      chamadas.soltarLock += 1;
    },
  };

  return { armazenamento, chamadas, atrasos, estado, gravacoes };
}

const emMs = (delta: number) => new Date(Date.now() + delta).toISOString();

const CREDENCIAL_COMPLETA = {
  access_token: 'token-vencido',
  client_id: 'id-do-app',
  client_secret: 'segredo-do-app',
  refresh_token: 'refresh-antigo',
  token_expires_at: emMs(-60_000),
};

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
  globalThis.fetch = (async (entrada: unknown) => {
    saidasDeRede.push(String(entrada));
    throw new Error('a suíte de token não pode sair na rede');
  }) as typeof globalThis.fetch;
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
    const { armazenamento } = armazenamentoFalso({ conexaoId: null });

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

    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      conexaoId: 'conexao-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
      agora,
    });

    expect(await token.renovar()).toBe('token-novinho');

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

  it('a falha é sempre `ErroDeTokenDoBling`', async () => {
    const { armazenamento } = armazenamentoFalso({ conexaoId: null });
    const token = new TokenDoBlingOrquestrado({
      organizacaoId: 'org-1',
      armazenamento,
      trocarToken: trocaBemSucedida,
    });

    await expect(token.renovar()).rejects.toBeInstanceOf(ErroDeTokenDoBling);
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
