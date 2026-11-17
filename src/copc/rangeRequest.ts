/**
 * The one Range GET both fetch paths share: sends `Range: bytes=begin-(end-1)`,
 * insists on `206`, and releases the body otherwise.
 */

/** Carries `status` so `isRetryable()` can tell a settled 4xx from a 5xx. */
export function httpStatusError(message: string, status: number): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Fetches one byte range and returns the `206` response. Anything else throws
 * `describe(status)`'s message via `httpStatusError`: a 200 means the server
 * ignored the Range header, and its body can be the whole file, so it is
 * cancelled rather than left streaming.
 */
export async function fetchPartial(
  url: string,
  begin: number,
  end: number,
  describe: (status: number) => string,
  signal?: AbortSignal,
  onHeaders?: () => void,
): Promise<Response> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${begin}-${end - 1}` },
    ...(signal ? { signal } : {}),
  });
  onHeaders?.();
  if (response.status !== 206) {
    void response.body?.cancel().catch(() => {});
    throw httpStatusError(describe(response.status), response.status);
  }
  return response;
}
