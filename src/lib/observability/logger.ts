export type LogSubsystem = 'app' | 'database' | 'queue' | 'provider';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  subsystem?: LogSubsystem;
  correlationId?: string;
  organizacaoId?: string;
  actorId?: string;
  [key: string]: unknown;
}

/**
 * A política de redação vive em `lib/dadosSensiveis.ts`, folha sem dependência.
 * Estava duplicada aqui e no cofre de credenciais, com regras diferentes: a do
 * cofre não cobria `cookie` nem variantes camelCase. Reexportado para os
 * chamadores que já conheciam este módulo como origem.
 */
export { redactSensitiveData, redactSensitiveText, chaveSensivel } from '../dadosSensiveis';

import { redactSensitiveData, redactSensitiveText } from '../dadosSensiveis';
/**
 * Extrai de um valor lançado (Error ou não) apenas nome e mensagem redigida, para uso
 * seguro em log estruturado. Nunca inclui o stack trace cru, que pode conter caminhos de
 * arquivo, query strings ou payloads sensíveis interpolados por bibliotecas externas.
 */
export function sanitizeErrorForLog(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: redactSensitiveText(err.message),
    };
  }
  if (typeof err === 'string') {
    return { name: 'UnknownError', message: redactSensitiveText(err) };
  }
  return { name: 'UnknownError', message: 'Erro não identificado' };
}

/**
 * Emite uma linha de log estruturada no formato JSON.
 */
export function logStructured(level: LogLevel, message: string, context?: LogContext): void {
  const sanitizedContext = context ? (redactSensitiveData(context) as LogContext) : {};
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    subsystem: context?.subsystem || 'app',
    message: redactSensitiveText(message),
    ...sanitizedContext,
  };

  const output = JSON.stringify(payload);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else if (level === 'info') {
    console.info(output);
  } else {
    console.debug(output);
  }
}

export const logger = {
  info: (message: string, context?: LogContext) => logStructured('info', message, context),
  warn: (message: string, context?: LogContext) => logStructured('warn', message, context),
  error: (message: string, context?: LogContext) => logStructured('error', message, context),
  debug: (message: string, context?: LogContext) => logStructured('debug', message, context),
};
