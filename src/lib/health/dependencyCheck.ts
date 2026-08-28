/**
 * Dependency-injected health check evaluator used by readiness/startup probes.
 *
 * Design invariants (Ticket 21):
 * - Fails closed: any thrown error, `ok:false` result, or timeout is reported as unhealthy.
 * - Never exposes provider detail (URL, key, stack, payload) to the caller of `evaluateDependencies`.
 *   Callers may pass `onError` to log a redacted diagnostic on the server side only.
 * - No dependency check performs a destructive write; this module has no opinion on what a
 *   dependency's `check` does internally, but readiness/startup wiring must only pass read-only checks.
 */

export type DependencyStatus = 'ok' | 'error' | 'timeout';

export interface DependencyCheck {
  readonly name: string;
  /** Must resolve `{ ok: boolean }` or throw. Must react to `signal` aborting (timeout). */
  readonly check: (signal: AbortSignal) => Promise<{ ok: boolean }>;
}

export interface DependencyOutcome {
  readonly name: string;
  readonly status: DependencyStatus;
}

export interface HealthCheckResult {
  readonly status: 'ready' | 'not_ready';
  readonly checks: readonly DependencyOutcome[];
}

export interface EvaluateDependenciesOptions {
  readonly timeoutMs?: number;
  /** Invoked with a redacted diagnostic when a dependency check throws or times out. Never receives the raw error. */
  readonly onError?: (dependencyName: string, outcome: 'error' | 'timeout') => void;
}

const DEFAULT_TIMEOUT_MS = 2000;

async function evaluateOne(
  dependency: DependencyCheck,
  timeoutMs: number,
  onError?: EvaluateDependenciesOptions['onError'],
): Promise<DependencyOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const timeoutSignal = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('dependency check timed out'));
      });
    });
    const result = await Promise.race([dependency.check(controller.signal), timeoutSignal]);
    return { name: dependency.name, status: result.ok ? 'ok' : 'error' };
  } catch {
    const status: DependencyStatus = timedOut ? 'timeout' : 'error';
    onError?.(dependency.name, status === 'timeout' ? 'timeout' : 'error');
    return { name: dependency.name, status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evaluate every indispensable dependency with a short, per-dependency timeout.
 * Fails closed: `not_ready` unless every dependency reports `ok`.
 */
export async function evaluateDependencies(
  dependencies: readonly DependencyCheck[],
  options: EvaluateDependenciesOptions = {},
): Promise<HealthCheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks = await Promise.all(
    dependencies.map((dependency) => evaluateOne(dependency, timeoutMs, options.onError)),
  );
  const status = checks.every((outcome) => outcome.status === 'ok') ? 'ready' : 'not_ready';
  return { status, checks };
}
