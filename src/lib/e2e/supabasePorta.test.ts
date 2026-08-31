import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { criarPortaSupabase } from './supabasePorta';

/**
 * Adapter real do projeto Supabase, exercitado contra um cliente dublê.
 *
 * Os testes de orquestração usam a **porta** falsa, então nunca alcançam este
 * arquivo — e é aqui que mora a paginação. Um teto atingido em silêncio faria a
 * limpeza tratar o não-lido como já removido.
 */

const POR_PAGINA = 200;
const TETO = 50;

// SAFETY: dublê parcial do cliente Supabase. O adapter só usa os métodos
// implementados aqui; tipar o cliente inteiro exigiria centenas de membros
// que este teste nunca toca, e o cast fica confinado ao arquivo de teste.

/** Cliente que sempre devolve páginas cheias: a listagem nunca termina. */
function clienteComPaginasInfinitas(): { supabase: SupabaseClient; chamadas: () => number } {
  let chamadas = 0;
  const supabase = {
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number; perPage: number }) => {
          chamadas += 1;
          return {
            data: {
              users: Array.from({ length: POR_PAGINA }, (_, i) => ({
                id: `id-${page}-${i}`,
                email: `orbita-e2e-run-1-p${page}-u${i}@e2e.orbita.test`,
              })),
            },
            error: null,
          };
        },
      },
    },
  // SAFETY: ver a nota no topo — dublê parcial, cast confinado ao teste.
  } as unknown as SupabaseClient;
  return { supabase, chamadas: () => chamadas };
}

/** Cliente cuja última página vem parcial: a listagem termina normalmente. */
function clienteComDuasPaginas(): SupabaseClient {
  return {
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number; perPage: number }) => ({
          data: {
            users: page === 1
              ? Array.from({ length: POR_PAGINA }, (_, i) => ({
                id: `id-1-${i}`,
                email: `orbita-e2e-run-1-u${i}@e2e.orbita.test`,
              }))
              : [{ id: 'id-2-0', email: 'orbita-e2e-run-1-ultimo@e2e.orbita.test' }],
          },
          error: null,
        }),
      },
    },
  // SAFETY: ver a nota acima.
  } as unknown as SupabaseClient;
}

describe('paginação de usuários', () => {
  it('teto atingido com a última página cheia é falha de leitura, não sucesso', async () => {
    // Devolver `Lido` aqui seria dizer "li tudo" tendo lido parte. A limpeza
    // então trataria o que não foi lido como já removido, e concluiria com
    // sucesso deixando usuários no projeto.
    const { supabase, chamadas } = clienteComPaginasInfinitas();

    const leitura = await criarPortaSupabase(supabase).lerUsuariosDaExecucao('run-1');

    expect(leitura._tag).toBe('FalhaDeLeitura');
    if (leitura._tag === 'FalhaDeLeitura') {
      expect(leitura.recurso).toBe('usuarios');
      expect(leitura.causa).toContain('incompleta');
      expect(leitura.causa).toContain(String(TETO));
    }
    // E parou no teto, em vez de girar sem fim.
    expect(chamadas()).toBe(TETO);
  });

  it('última página parcial encerra a leitura com sucesso', async () => {
    // O outro lado da guarda: apertar demais transformaria toda leitura normal
    // em falha, e a limpeza nunca rodaria.
    const leitura = await criarPortaSupabase(clienteComDuasPaginas()).lerUsuariosDaExecucao('run-1');

    expect(leitura._tag).toBe('Lido');
    if (leitura._tag === 'Lido') {
      expect(leitura.registros).toHaveLength(POR_PAGINA + 1);
      expect(leitura.registros.at(-1)?.identificador).toContain('ultimo');
    }
  });

  it('erro do provedor no meio da paginação vira falha, e não lista parcial', async () => {
    const supabase = {
      auth: {
        admin: {
          listUsers: async ({ page }: { page: number }) => (page === 1
            ? {
              data: {
                users: Array.from({ length: POR_PAGINA }, (_, i) => ({
                  id: `id-1-${i}`,
                  email: `orbita-e2e-run-1-u${i}@e2e.orbita.test`,
                })),
              },
              error: null,
            }
            : { data: null, error: { message: 'conexão recusada' } }),
        },
      },
    // SAFETY: ver a nota acima.
  } as unknown as SupabaseClient;

    const leitura = await criarPortaSupabase(supabase).lerUsuariosDaExecucao('run-1');

    expect(leitura).toMatchObject({ _tag: 'FalhaDeLeitura', causa: 'conexão recusada' });
  });

  it('só entram os usuários da execução, mesmo lendo a base inteira', async () => {
    // `listUsers` não filtra por substring, então a página traz todo mundo. O
    // filtro é nosso, e errar nele levaria a limpeza a alcançar conta real.
    const supabase = {
      auth: {
        admin: {
          listUsers: async () => ({
            data: {
              users: [
                { id: 'id-1', email: 'orbita-e2e-run-1-owner-a@e2e.orbita.test' },
                { id: 'id-2', email: 'orbita-e2e-run-9-outro@e2e.orbita.test' },
                { id: 'id-3', email: 'cliente@empresa-de-verdade.com' },
                { id: 'id-4', email: undefined },
              ],
            },
            error: null,
          }),
        },
      },
    // SAFETY: ver a nota acima.
  } as unknown as SupabaseClient;

    const leitura = await criarPortaSupabase(supabase).lerUsuariosDaExecucao('run-1');

    expect(leitura._tag).toBe('Lido');
    if (leitura._tag === 'Lido') {
      expect(leitura.registros.map((r) => r.id)).toEqual(['id-1']);
    }
  });
});
