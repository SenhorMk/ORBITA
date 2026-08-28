import {
  readSupabaseBrowserConfiguration,
  readSupabaseServerConfiguration,
} from '@/lib/runtime-config';
import { evaluateDependencies, type DependencyCheck, type DependencyStatus } from './dependencyCheck';

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface StartupCheckResult {
  readonly status: 'ready' | 'not_ready';
  readonly checks: {
    readonly config: 'ok' | 'error';
    readonly schema: DependencyStatus;
  };
}

/**
 * Proves initialization config is valid (no placeholder, both browser and server Supabase
 * configuration parse) without any I/O. Pure and safe to call in every test.
 */
export function evaluateStartupConfig(env: RuntimeEnvironment): 'ok' | 'error' {
  const server = readSupabaseServerConfiguration(env);
  const browser = readSupabaseBrowserConfiguration(env);
  const configValid =
    server._tag === 'ValidSupabaseServerConfiguration' &&
    browser._tag === 'ValidSupabaseBrowserConfiguration';
  return configValid ? 'ok' : 'error';
}

export interface EvaluateStartupOptions {
  readonly env?: RuntimeEnvironment;
  readonly schemaDependency: DependencyCheck;
  readonly timeoutMs?: number;
}

/**
 * Startup probe: proves the deployment initialized with valid configuration AND that the
 * database already carries the expected baseline schema (migrations were run as a prior,
 * observable step — never embedded in this probe). Fails closed: an invalid config short
 * circuits before any database call, so a misconfigured deployment never attempts to
 * connect with bad/placeholder credentials.
 */
export async function evaluateStartup({
  env = process.env,
  schemaDependency,
  timeoutMs,
}: EvaluateStartupOptions): Promise<StartupCheckResult> {
  const configStatus = evaluateStartupConfig(env);
  if (configStatus === 'error') {
    return { status: 'not_ready', checks: { config: 'error', schema: 'error' } };
  }

  const schemaResult = await evaluateDependencies([schemaDependency], { timeoutMs });
  const schemaStatus = schemaResult.checks[0]?.status ?? 'error';
  return {
    status: schemaStatus === 'ok' ? 'ready' : 'not_ready',
    checks: { config: 'ok', schema: schemaStatus },
  };
}
