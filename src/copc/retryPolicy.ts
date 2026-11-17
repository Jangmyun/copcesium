/** Retry policy shared by node Range Requests and hierarchy page loads. */

// Total attempts per node group.
export const MAX_ATTEMPTS = 3;
export const RETRY_BASE_MS = 250;

// Total attempts per hierarchy sub-page, with a longer base: a give-up there
// is permanent for the session.
export const MAX_PAGE_LOAD_ATTEMPTS = 3;
export const PAGE_RETRY_BASE_MS = 1000;

/** Exponential backoff: `baseMs` after the first failure, doubling after. */
export function backoffMs(baseMs: number, failures: number): number {
  return baseMs * 2 ** (failures - 1);
}
