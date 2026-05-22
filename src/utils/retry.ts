import pRetry, { AbortError } from 'p-retry';

import { AuthError, RateLimitError, ValidationError, mapSlackError } from '../errors/index.js';
import type { SlackMcpError } from '../errors/index.js';

import { ValidationError as ZodValidationError } from './validators.js';

export interface RetryOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
}

/**
 * Wraps an async function with exponential-backoff retry that:
 *   - aborts immediately on ValidationError (typed or Zod) and AuthError
 *   - honors RateLimitError.retryAfter before falling back to backoff
 *   - retries everything else (network, 5xx, NotFound, generic SlackApiError)
 *
 * `p-retry` v6 surfaces AbortError.originalError directly to the caller,
 * preserving the original error instance (verified against node_modules source).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (raw) {
        // Preserve the original Zod error for the outer wrap to convert into a
        // typed ValidationError. mapSlackError doesn't know about Zod shapes.
        if (raw instanceof ZodValidationError) {
          throw new AbortError(raw as unknown as Error);
        }

        const err: SlackMcpError = mapSlackError(raw);

        // Permanent failures — abort retry loop and surface immediately.
        if (err instanceof ValidationError || err instanceof AuthError) {
          throw new AbortError(err);
        }

        // Slack rate-limit responses tell us how long to wait. Honor that header
        // before letting p-retry's backoff decide.
        if (err instanceof RateLimitError) {
          await sleep(err.retryAfter * 1000);
        }

        // Anything else (network, 5xx, NotFound, generic SlackApiError) -> retry with backoff.
        throw err;
      }
    },
    {
      retries: opts.retries ?? 3,
      minTimeout: opts.minTimeoutMs ?? 250,
      maxTimeout: opts.maxTimeoutMs ?? 5000,
      factor: 2,
      randomize: true,
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
