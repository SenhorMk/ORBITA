/**
 * Categoria segura por classe de SQLSTATE. Lista fechada: o relatório nunca
 * reproduz texto do banco — nem `message`, que numa violação ou num `raise`
 * pode carregar valor de linha (e-mail, nome) tanto quanto o `detail`.
 */
const CATEGORIA_POR_CODIGO = Object.freeze({
  '42501': 'permissao_insuficiente',
  '55P03': 'tempo_de_lock_esgotado',
  '57014': 'tempo_de_consulta_esgotado',
  '40P01': 'deadlock',
});
const CATEGORIA_POR_CLASSE = Object.freeze({
  '08': 'conexao',
  '22': 'dado_invalido',
  '23': 'violacao_de_integridade',
  '25': 'estado_de_transacao',
  '28': 'autenticacao',
  '40': 'conflito_de_concorrencia',
  '42': 'sintaxe_ou_objeto',
  '53': 'recursos_insuficientes',
  '55': 'objeto_em_uso',
  '57': 'operacao_interrompida',
  P0: 'erro_levantado_pela_migration',
  XX: 'erro_interno_do_banco',
});

/**
 * O erro que pode ir para qualquer saída: SQLSTATE validado (cinco
 * caracteres) e uma categoria da lista acima. Nada mais do objeto do erro.
 *
 * @param {unknown} causa
 * @returns {{ readonly sqlstate: string | null, readonly categoria: string }}
 */
export function erroReportavel(causa) {
  const bruto = causa && typeof causa === 'object' && 'code' in causa ? causa.code : undefined;
  const sqlstate = typeof bruto === 'string' && /^[0-9A-Z]{5}$/u.test(bruto) ? bruto : null;
  if (sqlstate === null) return Object.freeze({ sqlstate: null, categoria: 'falha_sem_sqlstate' });
  const categoria = CATEGORIA_POR_CODIGO[sqlstate] ?? CATEGORIA_POR_CLASSE[sqlstate.slice(0, 2)] ?? 'outra_classe_de_erro';
  return Object.freeze({ sqlstate, categoria });
}

/** A forma curta do erro reportável, para a saída da CLI. */
export function descreverErroReportavel({ sqlstate, categoria }) {
  return sqlstate === null ? categoria : `SQLSTATE ${sqlstate}, ${categoria}`;
}
