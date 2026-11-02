import { z } from 'zod';

import { conexaoDesligada } from '../lib/integrations/conexaoDesligada';

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
  const codigo = codigoDeSqlstate(erro);

  // O código vai na **propriedade `code`**, não só na mensagem.
  // `registrarFalhaInterna` lê `erro.code` e ignora `Error.message` — uma versão
  // anterior devolvia o código apenas no texto, o log saía com
  // `codigo: undefined`, e o teste continuava verde porque conferia a mensagem
  // do objeto intermediário em vez da saída do logger.
  const registravel = new Error(
    codigo ? `Supabase recusou a operação (${codigo}).` : 'Supabase recusou a operação.',
  );
  if (codigo) Object.assign(registravel, { code: codigo });

  return registravel;
}

/**
 * Código do erro **na forma que o logger aceita**, ou `undefined`.
 *
 * A validação é a mesma de `codigoTecnicoValidado` em `falhaInterna.ts`:
 * SQLSTATE de cinco caracteres `[0-9A-Z]`. Chamar o código de "vocabulário
 * fechado" e aceitar qualquer string era contradição — e um código fora da
 * forma seria descartado pelo logger de qualquer jeito, deixando a mensagem
 * afirmar algo que o log não tem.
 *
 * `PGRST116` e afins ficam de fora por terem oito caracteres; é limite do
 * formato do logger, não descuido daqui.
 */
function codigoDeSqlstate(erro: unknown): string | undefined {
  if (typeof erro !== 'object' || erro === null || !('code' in erro)) return undefined;

  const bruto = (erro as { code?: unknown }).code;
  return typeof bruto === 'string' && /^[0-9A-Z]{5}$/u.test(bruto) ? bruto : undefined;
}

/**
 * Traduz a consulta da conexão. `error` **não** é ausência de conexão.
 *
 * Conexão desligada (PRE-008) conta como ausente: não se renova token nem se
 * chama o Bling por ela. Religar é refazer a conexão pela API autorizada.
 */
export function lerResultadoDaConexao(resposta: RespostaDoSupabase<{ id?: string; status?: unknown }>): ResultadoDaConexao {
  if (resposta.error) return { _tag: 'Indisponivel', causa: resposta.error };
  if (!resposta.data?.id || conexaoDesligada(resposta.data.status)) return { _tag: 'SemConexao' };
  return { _tag: 'Encontrada', conexaoId: resposta.data.id };
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

/**
 * As credenciais, lidas em vez de afirmadas.
 *
 * O cofre devolve `Record<string, unknown>`, e o código antigo alcançava os
 * campos com `as string` em cada uso: um `access_token` numérico viraria string
 * por decreto.
 *
 * `token_expires_at` é ISO **explícito** e transformado uma única vez em epoch.
 * Antes eram dois parses — um `refine` com o `Date` permissivo e outro na
 * comparação —, e o permissivo aceita coisas como `'2026'`.
 */
export const credenciaisSchema = z.object({
  access_token: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_expires_at: z.iso
    .datetime({ offset: true })
    .transform((valor) => new Date(valor).getTime())
    .optional(),
});

export type Credenciais = z.infer<typeof credenciaisSchema>;

/** Credenciais com os três campos que a renovação exige. */
type CredenciaisParaRenovar = Credenciais & {
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

/** Estreita em vez de afirmar com `!` nos três campos. */
export function completasParaRenovar(credenciais: Credenciais): credenciais is CredenciaisParaRenovar {
  return Boolean(credenciais.client_id && credenciais.client_secret && credenciais.refresh_token);
}

/** Sem data de validade, trata-se como vigente — é o que o código sempre fez. */
export function vencido(credenciais: Credenciais, agora: () => number): boolean {
  if (credenciais.token_expires_at === undefined) return false;
  return agora() >= credenciais.token_expires_at;
}
