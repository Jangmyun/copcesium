/** Retry policy shared by node Range Requests and hierarchy page loads. */

// Total attempts per node group.
export const MAX_NODE_ATTEMPTS = 3;
export const NODE_RETRY_BASE_MS = 250;

// Total attempts per hierarchy sub-page, with a longer base: a give-up there
// is permanent for the session.
export const MAX_PAGE_LOAD_ATTEMPTS = 3;
export const PAGE_RETRY_BASE_MS = 1000;

/** Exponential backoff: `baseMs` after the first failure, doubling after. */
export function backoffMs(baseMs: number, failures: number): number {
  return baseMs * 2 ** (failures - 1);
}

/** Whether a failed request is worth another attempt. Shared by node Range
 *  Requests and hierarchy page loads, so a settled 4xx (an answer that will
 *  never change) is classified the same way for both. */
export function isRetryable(err: unknown): boolean {
  // A cancelled request must never be retried — `cancel()`/`destroy()` raise
  // this name precisely to say the result is no longer wanted.
  if ((err as Error).name === 'AbortError') return false;
  const status = (err as { status?: number }).status;
  // No status means `fetch()` itself rejected (DNS failure, connection reset,
  // TLS error) rather than the server answering — transient often enough to
  // be worth another attempt.
  return status === undefined || status >= 500;
}
