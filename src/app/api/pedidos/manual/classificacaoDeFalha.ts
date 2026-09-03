/**
 * Classifica uma falha de `persistVenda` como definitiva ou ambígua (ticket
 * 30, fatia 3, endurecida na 3ª rodada de revisão).
 *
 * Separado num módulo puro, sem nenhuma dependência do `supabase-js` em
 * tempo de execução, exatamente para ser testável em isolamento: a fronteira
 * `definitivo` × `ambíguo` decide se uma compensação **destrutiva**
 * (cancelamento no Bling) pode acontecer, então ela não pode depender só da
 * leitura de como a biblioteca se comporta hoje — precisa de regressão
 * própria, e de uma política que erre para o lado seguro quando não
 * reconhecer o formato do erro.
 */

/** Desfecho da classificação. */
export type ClassificacaoDeFalha = 'Definitiva' | 'Ambigua';

/**
 * SQLSTATE de 5 caracteres alfanuméricos maiúsculos — o formato de `code` que
 * o PostgreSQL devolve para qualquer erro que o servidor processou até o fim
 * (`23505`, `22023`, `P0002`, `23514`, ...).
 */
const PADRAO_SQLSTATE = /^[0-9A-Z]{5}$/;

/** Códigos que o PostgREST usa para os próprios erros estruturados (não SQLSTATE). */
const PADRAO_POSTGREST = /^PGRST\d{1,4}$/;

/**
 * **Política conservadora, por reconhecimento positivo — não por exclusão.**
 *
 * Só é `Definitiva` um erro cujo `code` bate um dos dois formatos
 * conhecidos e documentados de "o servidor processou a requisição até o
 * fim". Qualquer coisa que não bata — `code` ausente, vazio, `undefined`,
 * de outro formato (`ECONNRESET`, `ETIMEDOUT`, um UUID de trace, texto
 * livre) — é `Ambigua`, mesmo que venha preenchida com *algo*.
 *
 * A escolha de reconhecer por PADRÃO em vez de checar `code !== ''` importa:
 * se uma falha de transporte um dia vier com um código de erro de rede
 * preenchido (em vez do `code: ""` que a versão instalada do
 * `@supabase/postgrest-js` usa hoje — ver `DEPENDENCIA_DE_VERSAO.md` ao lado
 * deste arquivo), a checagem por exclusão (`!== ''`) classificaria errado,
 * como Definitiva; a checagem por reconhecimento positivo continua correta,
 * porque `ECONNRESET` não bate nem `PADRAO_SQLSTATE` nem `PADRAO_POSTGREST`.
 *
 * @param error - O que `persistVenda` recebeu como falha — pode ser
 *                `null`/`undefined`, o objeto de erro do `supabase-js`, ou
 *                qualquer coisa inesperada; a função não assume forma nenhuma.
 * @returns `'Definitiva'` só com reconhecimento positivo; `'Ambigua'` em
 *          qualquer outro caso, inclusive os não previstos.
 */
export function classificarErroDePersistencia(error: unknown): ClassificacaoDeFalha {
  if (!error || typeof error !== 'object') return 'Ambigua';
  if (!('code' in error)) return 'Ambigua';
  const codigo = (error as { code: unknown }).code;
  if (typeof codigo !== 'string' || codigo === '') return 'Ambigua';
  if (PADRAO_SQLSTATE.test(codigo) || PADRAO_POSTGREST.test(codigo)) return 'Definitiva';
  return 'Ambigua';
}
