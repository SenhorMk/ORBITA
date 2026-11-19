import { describe, expect, it } from 'vitest';

import { persistOrganizationTokens } from './route';
import type { PersistBlingTokensInput } from './handler';

/**
 * A ordem de gravação do callback OAuth (revisão externa da PR #85).
 *
 * A regra: `status = 'conectado'` é a **última** escrita, e só acontece depois
 * de os tokens estarem no cofre. Antes, o mesmo upsert que descobria o id da
 * conexão já a declarava conectada — então uma falha do cofre logo em seguida
 * deixava a linha afirmando uma autorização que não existia em lugar nenhum.
 */

const ORG_ID = '20000000-0000-4000-8000-000000000001';

const ENTRADA: PersistBlingTokensInput = {
  userId: 'user-1',
  organizacaoId: ORG_ID,
  clientId: 'client-abc',
  clientSecret: 'secret-sintetico',
  organizationConnectionId: null,
  accessToken: 'access-sintetico',
  refreshToken: 'refresh-sintetico',
  expiresAt: '2026-09-10T13:00:00Z',
  correlationId: 'corr-callback-1',
};

/** Auditoria que aceita, registrando a conexão auditada e em que ponto das escritas aconteceu. */
function auditoriaFalsa(supabase?: { escritas: readonly unknown[] }) {
  const auditadas: Array<{ conexaoId: string; escritasAntes: number }> = [];
  const registrar = async (conexaoId: string) => {
    auditadas.push({ conexaoId, escritasAntes: supabase?.escritas.length ?? 0 });
  };
  return { registrar, auditadas };
}

const auditoriaOk = auditoriaFalsa().registrar;

/** Uma escrita feita contra `conexoes_integracao`, na ordem em que aconteceu. */
interface Escrita {
  readonly op: 'upsert' | 'update';
  readonly values: Record<string, unknown>;
}

/** Duplo mínimo do Supabase que registra a ordem e guarda o estado da linha. */
function supabaseFalso(opcoes: { readonly falharNoUpdate?: boolean } = {}) {
  const escritas: Escrita[] = [];
  const linha: { status: string } = { status: 'inexistente' };

  const client = {
    from() {
      return {
        upsert(values: Record<string, unknown>) {
          escritas.push({ op: 'upsert', values });
          linha.status = String(values.status);
          return { select: () => ({ single: async () => ({ data: { id: 'conexao-1' }, error: null }) }) };
        },
        update(values: Record<string, unknown>) {
          escritas.push({ op: 'update', values });
          if (!opcoes.falharNoUpdate) linha.status = String(values.status);
          // A rota encadeia .eq(id).eq(organizacao_id); o resultado sai no segundo.
          return {
            eq: () => ({
              eq: async () => ({ error: opcoes.falharNoUpdate ? { message: 'update recusado' } : null }),
            }),
          };
        },
      };
    },
  };

  // SAFETY: duplo mínimo; a função sob teste só usa `from().upsert/update`.
  return { client: client as never, escritas, linha };
}

/** Cofre que aceita ou recusa, registrando o que recebeu. */
function cofreFalso(falha: Error | null) {
  const gravacoes: Array<Record<string, unknown>> = [];
  const vault = {
    saveEncryptedCredentials: async (_org: string, _conexao: string, credenciais: Record<string, unknown>) => {
      if (falha) throw falha;
      gravacoes.push(credenciais);
    },
  };
  // SAFETY: duplo mínimo; só `saveEncryptedCredentials` é chamado aqui.
  return { vault: vault as never, gravacoes };
}

const loggerFalso = { info: () => {}, warn: () => {}, error: () => {} } as never;

describe('persistOrganizationTokens — conectado é a última escrita', () => {
  it('grava os tokens antes de declarar a conexão conectada', async () => {
    const supabase = supabaseFalso();
    const cofre = cofreFalso(null);

    await persistOrganizationTokens(supabase.client, cofre.vault, loggerFalso, ORG_ID, ENTRADA, auditoriaOk);

    // A linha nasce pendente; só a última escrita a declara conectada.
    expect(supabase.escritas[0]).toMatchObject({ op: 'upsert', values: { status: 'pendente' } });
    expect(supabase.escritas.at(-1)).toMatchObject({ op: 'update', values: { status: 'conectado' } });
    expect(cofre.gravacoes).toHaveLength(1);
    expect(supabase.linha.status).toBe('conectado');
  });

  it('a autorização nasce sem evidência de saúde: autorizar não é ter sido verificado', async () => {
    const supabase = supabaseFalso();

    await persistOrganizationTokens(supabase.client, cofreFalso(null).vault, loggerFalso, ORG_ID, ENTRADA, auditoriaOk);

    expect(supabase.escritas.at(-1)?.values).toMatchObject({
      last_health_check_at: null,
      last_health_error: null,
    });
  });

  it('o cofre falhar nunca deixa a conexão "conectado"', async () => {
    const supabase = supabaseFalso();
    const cofre = cofreFalso(new Error('cofre indisponível'));

    await expect(
      persistOrganizationTokens(supabase.client, cofre.vault, loggerFalso, ORG_ID, ENTRADA, auditoriaOk),
    ).rejects.toThrow();

    // Nenhuma escrita declarou `conectado`, e a linha ficou em `pendente` — a
    // tela dirá "Configurado, falta autorizar", que é exatamente a verdade.
    expect(supabase.escritas.every((escrita) => escrita.values.status !== 'conectado')).toBe(true);
    expect(supabase.linha.status).toBe('pendente');
    expect(cofre.gravacoes).toHaveLength(0);
  });

  it('falhar ao declarar conectado também é uma falha, e não um sucesso silencioso', async () => {
    // Tokens gravados sob um `pendente`: entendido de menos. O callback precisa
    // dizer isso, para o lojista refazer o Passo 2 em vez de achar que acabou.
    const supabase = supabaseFalso({ falharNoUpdate: true });

    await expect(
      persistOrganizationTokens(supabase.client, cofreFalso(null).vault, loggerFalso, ORG_ID, ENTRADA, auditoriaOk),
    ).rejects.toThrow();

    expect(supabase.linha.status).toBe('pendente');
  });

  describe('reconexão auditada (PRE-008)', () => {
    it('a autorização é auditada depois do cofre e antes de declarar conectado', async () => {
      const supabase = supabaseFalso();
      const auditoria = auditoriaFalsa(supabase);

      await persistOrganizationTokens(supabase.client, cofreFalso(null).vault, loggerFalso, ORG_ID, ENTRADA, auditoria.registrar);

      // Uma escrita (o upsert `pendente`) antes da auditoria; o `conectado` vem depois.
      expect(auditoria.auditadas).toEqual([{ conexaoId: 'conexao-1', escritasAntes: 1 }]);
      expect(supabase.escritas.at(-1)).toMatchObject({ op: 'update', values: { status: 'conectado' } });
    });

    it('sem rastro não há reativação: a auditoria recusada deixa a conexão pendente', async () => {
      const supabase = supabaseFalso();
      const recusar = async () => {
        throw new Error('Ator não pertence à organização — evento de auditoria recusado');
      };

      await expect(
        persistOrganizationTokens(supabase.client, cofreFalso(null).vault, loggerFalso, ORG_ID, ENTRADA, recusar),
      ).rejects.toThrow();

      expect(supabase.escritas.every((escrita) => escrita.values.status !== 'conectado')).toBe(true);
      expect(supabase.linha.status).toBe('pendente');
    });

    it('o cofre falhando, nem se audita uma autorização que não aconteceu', async () => {
      const auditoria = auditoriaFalsa();

      await expect(
        persistOrganizationTokens(supabaseFalso().client, cofreFalso(new Error('cofre')).vault, loggerFalso, ORG_ID, ENTRADA, auditoria.registrar),
      ).rejects.toThrow();

      expect(auditoria.auditadas).toEqual([]);
    });
  });
});
