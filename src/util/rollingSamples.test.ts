import { describe, expect, it } from 'vitest';
import { median, percentile, pushSample } from './rollingSamples';

describe('rollingSamples', () => {
  it('pushSample keeps only the newest `max` samples', () => {
    const w: number[] = [];
    for (let i = 1; i <= 5; i++) pushSample(w, i, 3);
    expect(w).toEqual([3, 4, 5]);
  });

  it('median handles empty, odd and even lengths without mutating input', () => {
    expect(median([])).toBeNaN();
    expect(median([3, 1, 2])).toBe(2);
    const xs = [4, 1, 3, 2];
    expect(median(xs)).toBe(2.5);
    expect(xs).toEqual([4, 1, 3, 2]);
  });

  it('percentile uses floor(n * fraction) clamped to the last index', () => {
    expect(percentile([], 0.5)).toBe(0);
    const xs = [5, 1, 4, 2, 3];
    expect(percentile(xs, 0.5)).toBe(3);
    expect(percentile(xs, 0.95)).toBe(5);
    expect(percentile(xs, 1)).toBe(5);
  });
});
