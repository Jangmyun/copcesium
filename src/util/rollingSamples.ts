/** Appends `value` to a rolling window, dropping the oldest sample past `max`. */
export function pushSample(window: number[], value: number, max: number): void {
  window.push(value);
  if (window.length > max) window.shift();
}

/** Median of the samples, or NaN when there are none. */
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank-style percentile (`fraction` in [0, 1)) of the samples, or 0 when there are none. */
export function percentile(xs: number[], fraction: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}
