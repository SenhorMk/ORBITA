import { logger } from './logger';

const CODIGO_SQLSTATE = /^[0-9A-Z]{5}$/u;

/** Código do erro apenas quando tem a forma fechada de um SQLSTATE. */
function codigoTecnicoValidado(erro: unknown): string | undefined {
  const bruto = (erro as { code?: unknown } | null | undefined)?.code;
  return typeof bruto === 'string' && CODIGO_SQLSTATE.test(bruto) ? bruto : undefined;
}

/**
 * Classes de erro que o log sabe nomear. **A lista é fechada, e é o ponto.**
 *
 * `Error.name` é gravável e aceita qualquer texto:
 * `Object.assign(new Error('falhou'), { name: 'alvo@empresa.com' })` colocaria
 * esse e-mail no log se o nome fosse copiado. Redigir por padrão não resolve —
 * o trabalho da redação é achar segredo com forma reconhecível (`Bearer …`,
 * JWT), e PII arbitrária não tem forma nenhuma.
 *
 * Então o nome não é lido: o erro é **classificado** contra os construtores
 * conhecidos, e o que sai é o rótulo desta lista. Um erro fora dela vira
 * `Error`; um valor lançado que nem Error é vira `UnknownError`.
 *
 * A classificação é por `instanceof`, na ordem em que as classes aparecem —
 * todas são irmãs, então a ordem não altera o resultado.
 */
const CLASSES_RECONHECIDAS: ReadonlyArray<readonly [new (...args: never[]) => Error, string]> = [
  [TypeError, 'TypeError'],
  [RangeError, 'RangeError'],
  [SyntaxError, 'SyntaxError'],
  [ReferenceError, 'ReferenceError'],
  [EvalError, 'EvalError'],
  [URIError, 'URIError'],
];

/**
 * Rótulo seguro da classe do erro, sem nunca consultar `error.name`.
 *
 * @param erro - Qualquer valor capturado.
 * @returns Um dos rótulos da lista fechada, `Error`, ou `UnknownError`.
 */
export function classificarErro(erro: unknown): string {
  if (!(erro instanceof Error)) return 'UnknownError';
  for (const [classe, rotulo] of CLASSES_RECONHECIDAS) {
    if (erro instanceof classe) return rotulo;
  }
  // Qualquer outro `Error` — inclusive subclasse do aplicativo, como
  // `EntitlementDeniedError` — sai como `Error` genérico. Isso perde
  // granularidade de diagnóstico de propósito: reconhecer a subclasse exigiria
  // ou importá-la aqui (ciclo de dependência com os serviços) ou voltar a
  // confiar no nome que ela mesma escreve. Quando alguma subclasse precisar
  // aparecer no log, ela entra nesta lista, explicitamente.
  return 'Error';
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
 * A classe vem de `classificarErro`, que decide por `instanceof` e nunca lê
 * `error.name` — o nome é gravável, e quem controla o objeto lançado
 * controlaria o que entra no log.
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
    erro: classificarErro(erro),
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
