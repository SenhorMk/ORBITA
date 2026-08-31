/**
 * Redação de chaves sensíveis, sem dependência de nada.
 *
 * Mora numa folha própria porque `descreverErro` (`lib/erroLegivel.ts`) precisa
 * dela, e `erroLegivel` é importado por componentes de interface. Importar o
 * cofre de credenciais de dentro de um componente arrastaria `crypto` e o
 * cliente Supabase de servidor para o bundle do navegador.
 */

const SENSITIVE_KEYS = new Set([
  'client_secret',
  'clientsecret',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'api_key',
  'apikey',
  'secret',
  'token',
  'password',
  'authorization',
  'dados_cifrados',
  'encrypted_secret',
  'webhook_secret',
]);

/**
 * Deeply redacts sensitive keys from an object or array to ensure
 * secrets are never leaked into logs, error messages, or client payloads.
 */
export function redactSensitiveData(input: unknown): unknown {
  if (input === null || input === undefined || typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (SENSITIVE_KEYS.has(key.toLowerCase()) || SENSITIVE_KEYS.has(normalizedKey)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveData(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
