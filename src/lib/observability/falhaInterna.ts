import { logger, sanitizeErrorForLog } from './logger';

const CODIGO_SQLSTATE = /^[0-9A-Z]{5}$/u;

/** Código do erro apenas quando tem a forma fechada de um SQLSTATE. */
function codigoTecnicoValidado(erro: unknown): string | undefined {
  const bruto = (erro as { code?: unknown } | null | undefined)?.code;
  return typeof bruto === 'string' && CODIGO_SQLSTATE.test(bruto) ? bruto : undefined;
}

/** Contexto de negócio que acompanha a falha no log, e nunca a resposta. */
export interface ContextoDaFalha {
  readonly organizacaoId?: string;
  readonly atorId?: string;
}

/**
 * Registra a falha no servidor sem carregar nada que não possa ser lido depois.
 *
 * Deliberadamente **não** registra `message`, `details` nem `hint`. Numa
 * violação de unicidade o Postgres coloca valores de linha dentro deles
 * (`Key (email)=(...) already exists`), ou seja, dado de cliente. O que fica é
 * qual operação falhou, em qual organização, a classe do erro e o SQLSTATE.
 *
 * Esta é a convenção que o ticket 04 estabeleceu em
 * `src/app/api/pedidos/status/handler.ts` contra CWE-209. O ticket 20 a
 * generalizou porque, ao tornar as rotas de organização alcançáveis, cinco
 * `catch` que devolviam `error.message` ao cliente deixaram de ser inertes.
 *
 * @param operacao - Nome estável da operação, para busca no log.
 * @param erro - O erro capturado, de qualquer forma.
 * @param contexto - Identificadores de negócio, nunca conteúdo.
 */
export function registrarFalhaInterna(
  operacao: string,
  erro: unknown,
  contexto: ContextoDaFalha = {},
): void {
  logger.error(`Falha interna em ${operacao}`, {
    subsystem: 'app',
    operacao,
    ...contexto,
    erro: sanitizeErrorForLog(erro).name,
    codigo: codigoTecnicoValidado(erro),
  });
}

/**
 * Frase pública fixa das falhas internas.
 *
 * Ela é a mesma para toda causa de propósito: qualquer variação por causa é um
 * canal lateral que informa quem não deveria ser informado.
 */
export const MENSAGEM_PUBLICA_DE_FALHA = 'Erro interno';
