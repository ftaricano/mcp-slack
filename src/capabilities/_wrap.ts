import { mapSlackError, SlackMcpError, ValidationError } from '../errors/index.js';
import { slackCallDuration, slackCallsCounter } from '../observability/metrics.js';
import { withRetry } from '../utils/retry.js';
import { ValidationError as ZodValidationError } from '../utils/validators.js';

/**
 * Wraps a capability handler so any error it throws is normalized into the
 * typed error hierarchy in `errors/index.ts`. Callers can then
 * `instanceof RateLimitError` / `AuthError` / `NotFoundError` / `ValidationError`
 * instead of pattern-matching opaque strings.
 *
 * Retries transient failures with exponential backoff via `withRetry` —
 * but ONLY when `opts.idempotent === true`. Mutating Slack tools
 * (chat.postMessage, conversations.create, files.upload, …) MUST NOT be
 * replayed: if Slack committed the first attempt but the response timed out,
 * a retry produces duplicate messages, channels or files. Default is
 * `idempotent: false` (fail-safe).
 *
 * Validation/Auth errors abort the retry loop immediately; RateLimit honors
 * the server-supplied retry-after.
 *
 * Records Prometheus metrics:
 *  - `mcp_slack_calls_total{tool,outcome}` — outcome is `ok` on success or
 *    the lowercased error code (e.g. `rate_limit`, `auth`, `validation`).
 *  - `mcp_slack_call_duration_seconds{tool}` — wall-clock latency.
 */
export function wrap<TArgs, TResult>(
  toolName: string,
  fn: (args: TArgs) => Promise<TResult>,
  opts: { idempotent?: boolean } = {},
): (args: TArgs) => Promise<TResult> {
  const idempotent = opts.idempotent ?? false;
  return async (args: TArgs): Promise<TResult> => {
    const stopTimer = slackCallDuration.startTimer({ tool: toolName });
    try {
      const result = idempotent ? await withRetry(() => fn(args)) : await fn(args);
      slackCallsCounter.inc({ tool: toolName, outcome: 'ok' });
      return result;
    } catch (err) {
      let typed: SlackMcpError;
      // Zod-shaped validation errors from utils/validators -> typed ValidationError.
      if (err instanceof ZodValidationError) {
        typed = new ValidationError(err.message, { cause: err });
      } else if (err instanceof SlackMcpError) {
        // Already typed: rethrow untouched so the cause chain stays intact.
        typed = err;
      } else {
        // Map Slack-shaped errors / generic errors to the typed hierarchy.
        typed = mapSlackError(err);
      }
      slackCallsCounter.inc({ tool: toolName, outcome: typed.code.toLowerCase() });
      throw typed;
    } finally {
      stopTimer();
    }
  };
}
