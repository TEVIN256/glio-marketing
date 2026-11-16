import { PlatformError } from "@glio/connectors";

export interface RetryOptions {
  /** Attempts in total, including the first. */
  attempts: number;
  /** Delay before the 2nd attempt; doubles each time. */
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultRetry: RetryOptions = {
  attempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Retry only errors the platform marked as transient; fail fast on the rest. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let delay = opts.baseDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof PlatformError && err.retryable;
      if (!retryable || attempt >= opts.attempts) throw err;
      await opts.sleep(Math.min(delay, opts.maxDelayMs));
      delay *= 2;
    }
  }
}
