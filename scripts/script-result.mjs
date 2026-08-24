/**
 * Construct a successful script result.
 *
 * @param {unknown} value - Successful value.
 * @returns {{ readonly _tag: 'ok', readonly value: unknown }} Tagged success.
 */
export function ok(value) {
  return Object.freeze({ _tag: 'ok', value });
}

/**
 * Construct an expected, safely reportable script failure.
 *
 * @param {string} tag - Stable failure tag.
 * @param {string} message - Safe diagnostic message.
 * @param {Record<string, unknown>} [context] - Non-sensitive diagnostic fields.
 * @param {unknown} [cause] - Original boundary failure, retained for local diagnosis only.
 * @returns {{ readonly _tag: 'err', readonly error: Readonly<Record<string, unknown>> }} Tagged failure.
 */
export function err(tag, message, context = {}, cause) {
  return Object.freeze({
    _tag: 'err',
    error: Object.freeze({ _tag: tag, message, ...context, ...(cause === undefined ? {} : { cause }) }),
  });
}

/**
 * Render an unknown or tagged failure without exposing boundary payloads.
 *
 * @param {unknown} failure - Failure returned by a script module.
 * @returns {string} Safe message for the CLI.
 */
export function failureMessage(failure) {
  if (failure && typeof failure === 'object' && 'message' in failure && typeof failure.message === 'string') {
    const lines = [failure.message];
    for (const [label, field] of [
      ['primary', 'primaryFailure'],
      ['cleanup', 'cleanupFailure'],
    ]) {
      if (!(field in failure)) continue;
      const detail = failure[field];
      if (!detail || typeof detail !== 'object') continue;
      const tag = 'tag' in detail && typeof detail.tag === 'string' ? detail.tag : 'UnknownFailure';
      const message = 'message' in detail && typeof detail.message === 'string'
        ? detail.message
        : 'No safe failure message was provided';
      lines.push(`${label}: [${tag}] ${message}`);
    }
    return lines.join('\n');
  }
  if (failure instanceof Error) return failure.message;
  return String(failure);
}
