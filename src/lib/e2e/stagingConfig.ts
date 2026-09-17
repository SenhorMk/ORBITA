/**
 * Fail-closed configuration resolver for real-browser E2E runs against a
 * staging environment.
 *
 * `playwright.config.ts` imports `resolveStagingConfig` and calls it at
 * module load time: if the environment is not an explicit, verifiably
 * non-production staging target, resolution throws and Playwright never
 * starts. There is intentionally no fallback to `localhost`, no default
 * URL, and no way to silently proceed with an unverified target.
 */

export class StagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingConfigError';
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.startsWith('127.');
}

function parseHttpsUrl(rawValue: string, variableName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new StagingConfigError(`${variableName} não é uma URL válida: "${rawValue}".`);
  }
  if (parsed.protocol !== 'https:') {
    throw new StagingConfigError(
      `${variableName} deve usar HTTPS explícito. Protocolo recebido: "${parsed.protocol}".`,
    );
  }
  if (isLoopbackHostname(parsed.hostname)) {
    throw new StagingConfigError(
      `${variableName} não pode apontar para localhost/loopback ("${parsed.hostname}"). ` +
        'E2E real exige um host de staging publicado, nunca um fallback local.',
    );
  }
  return parsed;
}

export interface StagingConfig {
  readonly baseURL: string;
  readonly supabaseUrl: string | null;
  readonly stripeMode: 'test' | 'not-configured';
}

export interface ResolveStagingConfigOptions {
  /**
   * Bypasses the "hostname contains staging" heuristic. Only ever set from
   * unit tests exercising the HTTPS/loopback rules in isolation — never set
   * this from real configuration.
   */
  readonly allowAnyNonLocalHostnameForTest?: boolean;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Resolve and validate the environment required to run the real-browser E2E
 * suite against staging. Throws `StagingConfigError` (never returns a
 * partially-valid or best-effort config) when any required signal is
 * missing or looks like production/local.
 */
export function resolveStagingConfig(
  env: EnvLike = process.env,
  options: ResolveStagingConfigOptions = {},
): StagingConfig {
  const stagingUrlRaw = env.STAGING_URL?.trim();
  if (!stagingUrlRaw) {
    throw new StagingConfigError(
      'STAGING_URL é obrigatória e está ausente. Defina uma URL HTTPS explícita do ambiente de staging ' +
        '(ex.: STAGING_URL=https://staging.orbita.example.com) antes de rodar Playwright. Não há fallback ' +
        'para localhost nem qualquer outro alvo padrão.',
    );
  }

  const stagingUrl = parseHttpsUrl(stagingUrlRaw, 'STAGING_URL');
  if (!options.allowAnyNonLocalHostnameForTest) {
    const hostAlvo = stagingUrl.hostname.toLowerCase();
    const hostConfirmado = env.E2E_HOST_CONFIRMADO?.trim().toLowerCase();

    // A heurística "o host contém staging" resolve o caso comum e não resolve
    // o nosso: não existe ambiente de staging separado, e o alvo real é o
    // host de desenvolvimento publicado. A saída **não** é afrouxar nem usar o
    // atalho reservado aos testes — é a mesma trava do Supabase, que é mais
    // forte que a heurística: o operador digita o host exato.
    //
    // Um host chamado "staging-prod.example.com" passa na heurística; aqui,
    // apontar para um host que você não escreveu é impossível.
    if (!hostAlvo.includes('staging') && !hostConfirmado) {
      throw new StagingConfigError(
        `STAGING_URL ("${hostAlvo}") não contém "staging" no host, então exige confirmação nominal. ` +
          `Defina E2E_HOST_CONFIRMADO="${hostAlvo}" para declarar por escrito contra qual ambiente a suíte ` +
          'pode criar e apagar dados. Essa exigência é uma salvaguarda deliberada contra apontar ' +
          'acidentalmente para produção.',
      );
    }

    if (hostConfirmado && hostConfirmado !== hostAlvo) {
      throw new StagingConfigError(
        `E2E_HOST_CONFIRMADO ("${hostConfirmado}") não corresponde ao host de STAGING_URL ("${hostAlvo}"). ` +
          'A suíte recusa rodar contra um ambiente que não foi confirmado nominalmente.',
      );
    }
  }

  let supabaseUrl: string | null = null;
  const supabaseUrlRaw = env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (supabaseUrlRaw) {
    const parsedSupabaseUrl = parseHttpsUrl(supabaseUrlRaw, 'SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL');

    // A regra anterior exigia "staging" no host do Supabase. Era impossível de
    // satisfazer: host de Supabase é sempre `<ref>.supabase.co`, e o ref é
    // gerado, nunca contém o nome do projeto. Nenhum projeto real passaria —
    // e por isso a suíte E2E nunca rodou, nem uma vez.
    //
    // A trava agora é mais forte, não mais fraca: o operador precisa DIGITAR o
    // ref exato do projeto alvo. Um host chamado "staging-prod.supabase.co"
    // passava na regra antiga; aqui, apontar para um projeto cujo ref você não
    // escreveu é impossível.
    if (!options.allowAnyNonLocalHostnameForTest) {
      const refAlvo = parsedSupabaseUrl.hostname.toLowerCase().split('.')[0] ?? '';
      const refConfirmado = env.E2E_SUPABASE_REF?.trim().toLowerCase();

      if (!refConfirmado) {
        throw new StagingConfigError(
          'E2E_SUPABASE_REF é obrigatória quando SUPABASE_URL está definida. Ela confirma, por escrito, ' +
            `contra qual projeto Supabase a suíte pode rodar. O alvo atual é "${refAlvo}". ` +
            'Sem essa confirmação explícita, um E2E que cria e apaga dados poderia atingir o projeto errado.',
        );
      }

      if (refConfirmado !== refAlvo) {
        throw new StagingConfigError(
          `E2E_SUPABASE_REF ("${refConfirmado}") não corresponde ao projeto de SUPABASE_URL ("${refAlvo}"). ` +
            'A suíte recusa rodar contra um projeto que não foi confirmado nominalmente.',
        );
      }
    }

    supabaseUrl = parsedSupabaseUrl.toString();
  }

  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim();
  let stripeMode: StagingConfig['stripeMode'] = 'not-configured';
  if (stripeSecretKey) {
    if (stripeSecretKey.startsWith('sk_live_')) {
      throw new StagingConfigError(
        'STRIPE_SECRET_KEY começa com "sk_live_" (modo live). E2E real deve usar exclusivamente Stripe Test ' +
          'Mode ("sk_test_..."). Uma chave live nunca é aceitável aqui, mesmo temporariamente.',
      );
    }
    if (!stripeSecretKey.startsWith('sk_test_')) {
      throw new StagingConfigError(
        'STRIPE_SECRET_KEY não é reconhecida como chave de teste Stripe válida (esperado prefixo "sk_test_").',
      );
    }
    stripeMode = 'test';
  }

  return {
    baseURL: stagingUrl.toString(),
    supabaseUrl,
    stripeMode,
  };
}
