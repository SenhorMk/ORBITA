/**
 * Classifica uma falha de `persistVenda` como definitiva ou ambígua (ticket
 * 30, fatia 3 — endurecida na 3ª rodada, allowlist na 4ª rodada).
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
 * **Allowlist, não formato (4ª rodada de revisão).**
 *
 * A versão anterior reconhecia qualquer `code` de 5 caracteres
 * alfanuméricos maiúsculos (`/^[0-9A-Z]{5}$/`) como definitivo — o formato
 * de um SQLSTATE, mas não PROVA de que aquele valor é um SQLSTATE de
 * verdade vindo do PostgreSQL. A revisão apontou o caso concreto: uma
 * biblioteca poderia devolver `code: 'ERROR'` — 5 letras maiúsculas, bate o
 * regex, mas não é um SQLSTATE registrado em lugar nenhum.
 *
 * Por isso a política deixou de ser "reconheço o FORMATO" e passou a ser
 * "reconheço estes CÓDIGOS específicos" — os SQLSTATE que
 * `registrar_venda_manual` (migrations 53/56/57), `baixar_estoque_organizacao`
 * (migration 56) e `reivindicar_tentativa_venda_manual` (migration 59)
 * genuinamente levantam, lidos direto do SQL:
 *
 * - `23505` — unique_violation. A guarda da migration 57
 *   (`uq_pedidos_org_bling`) e a chave única de `tentativas_venda_manual`.
 * - `22023` — invalid_parameter_value. Os `RAISE EXCEPTION` explícitos de
 *   parâmetro obrigatório ausente, nos dois lados.
 * - `P0002` — no_data_found. "Cliente não encontrado para a organização
 *   verificada."
 * - `23514` — check_violation. Estoque insuficiente
 *   (`baixar_estoque_organizacao`).
 * - `23503` — foreign_key_violation. Não é levantado hoje por nenhum FK
 *   direto no caminho de `registrar_venda_manual` (produto e cliente já são
 *   validados contra a organização antes), mas fica na lista porque é um
 *   SQLSTATE genuinamente do PostgreSQL para violação de integridade — a
 *   mesma família de `23505`/`23514` — e não um valor arbitrário.
 *
 * Qualquer código que não esteja aqui — incluindo um que tenha o FORMATO
 * certo, como `ERROR` — cai em `Ambigua`. Ver
 * `classificacaoDeFalha.test.ts` para a regressão específica desse caso.
 */
const CODIGOS_SQLSTATE_DEFINITIVOS: ReadonlySet<string> = new Set([
  '23505', // unique_violation
  '22023', // invalid_parameter_value
  'P0002', // no_data_found
  '23514', // check_violation
  '23503', // foreign_key_violation
]);

/**
 * Códigos que o PostgREST usa para os PRÓPRIOS erros estruturados (não
 * SQLSTATE) — um prefixo documentado e controlado pelo provedor
 * (`PGRST` + número), não uma coincidência de formato.
 */
const PADRAO_POSTGREST = /^PGRST\d{1,4}$/;

/**
 * **Política conservadora, por reconhecimento positivo — não por exclusão,
 * e não por formato.**
 *
 * Só é `Definitiva` um erro cujo `code` está na allowlist de SQLSTATE
 * conhecidos, ou bate o prefixo `PGRST` do PostgREST. Qualquer coisa que
 * não bata — `code` ausente, vazio, `undefined`, de outro formato
 * (`ECONNRESET`, `ETIMEDOUT`, um UUID de trace, texto livre), ou até um
 * código de 5 letras maiúsculas que PARECE um SQLSTATE mas não é nenhum dos
 * que este código levanta (`ERROR`, por exemplo) — é `Ambigua`.
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
  if (CODIGOS_SQLSTATE_DEFINITIVOS.has(codigo) || PADRAO_POSTGREST.test(codigo)) return 'Definitiva';
  return 'Ambigua';
}
