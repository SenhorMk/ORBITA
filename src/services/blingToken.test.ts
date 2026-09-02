import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ArmazenamentoDeCredenciais } from './blingToken';

// O módulo valida a configuração do Supabase no topo, mesmo quando o
// armazenamento vai ser dublado — por isso o import é dinâmico.
let TokenDoBlingSupabase: typeof import('./blingToken').TokenDoBlingSupabase;
let lerCredenciais: typeof import('./blingToken').lerCredenciais;

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://token-test-000000.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'token-test-service-role-key-000000');
  ({ TokenDoBlingSupabase, lerCredenciais } = await import('./blingToken'));
});

/**
 * Ticket 31 — obtenção e renovação do token.
 *
 * O armazenamento é dublado **por inteiro**, nunca campo a campo: uma versão
 * anterior das portas aceitava peças parciais e completava o resto com Supabase
 * e cofre reais, o que deixava o teste meio isolado e meio real sem nada
 * avisar. Aqui ou é tudo dublê, ou é tudo produção.
 */

interface Registro {
  conexaoId: string | null;
  credenciais: unknown;
  lockLivre: boolean;
}

function armazenamentoFalso(inicial: Partial<Registro> = {}) {
  const estado: Registro = {
    // `??` aqui apagava o caso que interessa: `null` é 'não há conexão', e não
    // 'não informado'. O próprio teste de recusa pegou isso.
    conexaoId: 'conexaoId' in inicial ? (inicial.conexaoId ?? null) : 'conexao-1',
    credenciais: inicial.credenciais ?? { access_token: 'token-valido' },
    lockLivre: inicial.lockLivre ?? true,
  };

  const chamadas = { acharConexaoId: 0, ler: 0, gravar: 0, tentarLock: 0, soltarLock: 0 };
  const atrasos: Record<'acharConexaoId' | 'ler', number> = { acharConexaoId: 0, ler: 0 };

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
    gravar: async (_org, _con, credenciais) => {
      chamadas.gravar += 1;
      estado.credenciais = credenciais;
      return null;
    },
    tentarLock: async () => {
      chamadas.tentarLock += 1;
      return estado.lockLivre;
    },
    soltarLock: async () => {
      chamadas.soltarLock += 1;
      return null;
    },
  };

  return { armazenamento, chamadas, estado, atrasos };
}

const vencidoEm = (deltaMs: number) => new Date(Date.now() + deltaMs).toISOString();

describe('lerCredenciais', () => {
  it('lê os campos que interessam e descarta o resto', () => {
    expect(lerCredenciais({ access_token: 'abc', lixo: 1 })).toEqual({ access_token: 'abc' });
  });

  it('recusa o que não tem a forma esperada, em vez de afirmar', () => {
    // O código antigo alcançava os campos com `as string` em cada uso. Um
    // `access_token` numérico viraria string por decreto.
    expect(lerCredenciais({ access_token: 42 })).toBeNull();
    expect(lerCredenciais(null)).toBeNull();
    expect(lerCredenciais('texto')).toBeNull();
  });
});

describe('obter', () => {
  it('devolve o token vigente sem renovar', async () => {
    const { armazenamento, chamadas } = armazenamentoFalso({
      credenciais: { access_token: 'token-valido', token_expires_at: vencidoEm(60_000) },
    });
    const token = new TokenDoBlingSupabase({ organizacaoId: 'org-1', armazenamento });

    expect(await token.obter()).toBe('token-valido');
    expect(chamadas.tentarLock).toBe(0);
  });

  it('renova quando o token já venceu', async () => {
    const { armazenamento, chamadas } = armazenamentoFalso({
      credenciais: {
        access_token: 'token-vencido',
        client_id: 'id',
        client_secret: 'segredo',
        refresh_token: 'refresh',
        token_expires_at: vencidoEm(-60_000),
      },
    });
    const token = new TokenDoBlingSupabase({ organizacaoId: 'org-1', armazenamento });

    // A renovação real fala com o Bling; aqui só interessa que ela foi tentada.
    await token.obter().catch(() => undefined);
    expect(chamadas.tentarLock).toBe(1);
  });

  it('não começa a ler o cofre quando a busca da conexão já consumiu o prazo', async () => {
    // A afirmação anterior era maior que o código: a busca da conexão vem antes
    // da leitura do cofre, e não havia conferência entre as duas.
    const { armazenamento, chamadas, atrasos } = armazenamentoFalso();
    atrasos.acharConexaoId = 80;

    const token = new TokenDoBlingSupabase({ organizacaoId: 'org-1', armazenamento });
    const controle = new AbortController();
    setTimeout(() => controle.abort(new Error('prazo')), 20);

    await expect(token.obter(controle.signal)).rejects.toThrow(/prazo/u);
    expect(chamadas.acharConexaoId).toBe(1);
    expect(chamadas.ler).toBe(0);
  });

  it('não começa a renovação quando a leitura do cofre já consumiu o prazo', async () => {
    // O passo mais caro e o menos interrompível: polling de lock com `await` de
    // banco. É o último ponto onde dá para evitar o gasto.
    const { armazenamento, chamadas, atrasos } = armazenamentoFalso({
      credenciais: {
        access_token: 'token-vencido',
        client_id: 'id',
        client_secret: 'segredo',
        refresh_token: 'refresh',
        token_expires_at: vencidoEm(-60_000),
      },
    });
    atrasos.ler = 80;

    const token = new TokenDoBlingSupabase({ organizacaoId: 'org-1', armazenamento });
    const controle = new AbortController();
    setTimeout(() => controle.abort(new Error('prazo')), 20);

    await expect(token.obter(controle.signal)).rejects.toThrow(/prazo/u);
    expect(chamadas.ler).toBe(1);
    expect(chamadas.tentarLock).toBe(0);
  });

  it('recusa quando não há conexão', async () => {
    const { armazenamento } = armazenamentoFalso({ conexaoId: null });
    const token = new TokenDoBlingSupabase({ organizacaoId: 'org-1', armazenamento });

    await expect(token.obter()).rejects.toThrow(/nao conectado/u);
  });
});

describe('renovar quando outro processo tem o lock', () => {
  it('espera o token que o outro publicar', async () => {
    const { armazenamento, estado } = armazenamentoFalso({
      lockLivre: false,
      credenciais: { access_token: 'antigo', token_expires_at: vencidoEm(-1) },
    });

    const token = new TokenDoBlingSupabase({
      organizacaoId: 'org-1',
      armazenamento,
      // Sem espera real: o teste não deve levar 2 segundos por tentativa.
      dormir: async () => {
        estado.credenciais = { access_token: 'publicado-pelo-outro', token_expires_at: vencidoEm(60_000) };
      },
    });

    expect(await token.renovar()).toBe('publicado-pelo-outro');
  });

  it('desiste depois das tentativas, em vez de esperar para sempre', async () => {
    const { armazenamento } = armazenamentoFalso({
      lockLivre: false,
      credenciais: { access_token: 'antigo', token_expires_at: vencidoEm(-1) },
    });

    const token = new TokenDoBlingSupabase({
      organizacaoId: 'org-1',
      armazenamento,
      dormir: async () => {},
    });

    await expect(token.renovar()).rejects.toThrow(/Timeout/u);
  });
});
