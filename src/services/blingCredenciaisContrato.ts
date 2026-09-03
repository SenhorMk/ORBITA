import type { ResultadoDaConexao, ResultadoDoLock } from './blingToken';

/**
 * Tradução das respostas do Supabase para os tipos do domínio.
 *
 * Mora fora do adapter porque não depende de infraestrutura nenhuma: o adapter
 * faz a chamada, estas funções leem a resposta. Separadas, dá para prová-las
 * sem dublar módulo e sem configurar ambiente — e era justamente esta a única
 * fronteira do desenho novo sem prova, a que todo o resto pressupõe correta.
 *
 * Um `tentarLock` que mapeasse ao contrário deixaria duas requisições renovando
 * ao mesmo tempo, cada uma consumindo o refresh token rotacionado da outra, e a
 * suíte inteira continuaria verde porque todos os testes usam armazenamento
 * dublado.
 */

/** A forma que o PostgREST devolve em consulta e em RPC. */
export interface RespostaDoSupabase<T> {
  readonly data: T | null;
  readonly error: unknown;
}

/**
 * Erro do PostgREST reduzido ao que dá para registrar sem risco.
 *
 * `registrarFalhaInterna` grava a **classe** do erro por `instanceof Error`, e o
 * objeto do PostgREST é objeto simples: as chamadas daqui gravavam sempre
 * `UnknownError`, sem nada que distinguisse um lock que falha de qualquer outra
 * coisa. O `code` do Postgres é vocabulário fechado — `42501`, `PGRST116` — e
 * não carrega valor de linha, ao contrário de `details` e `hint`, que ficam de
 * fora de propósito.
 */
export function erroRegistravel(erro: unknown): Error {
  const codigo =
    typeof erro === 'object' && erro !== null && 'code' in erro && typeof erro.code === 'string'
      ? erro.code
      : 'sem-codigo';

  return new Error(`Supabase recusou a operação (${codigo}).`);
}

/** Traduz a consulta da conexão. `error` **não** é ausência de conexão. */
export function lerResultadoDaConexao(resposta: RespostaDoSupabase<{ id?: string }>): ResultadoDaConexao {
  if (resposta.error) return { _tag: 'Indisponivel', causa: resposta.error };
  return resposta.data?.id ? { _tag: 'Encontrada', conexaoId: resposta.data.id } : { _tag: 'SemConexao' };
}

/**
 * Traduz a disputa do lock.
 *
 * Três desfechos distintos: `error` é a tentativa que falhou, `data` verdadeiro
 * é o lock adquirido, e `data` falso é outro processo renovando. Tratar o
 * primeiro como o terceiro mandava o chamador esperar meio minuto por uma
 * renovação que ninguém estava fazendo.
 */
export function lerResultadoDoLock(resposta: RespostaDoSupabase<boolean>): ResultadoDoLock {
  if (resposta.error) return { _tag: 'Indisponivel', causa: resposta.error };
  return resposta.data ? { _tag: 'Adquirido' } : { _tag: 'Ocupado' };
}
