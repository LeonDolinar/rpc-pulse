import { describe, expect, it } from 'vitest';
import { median, percentile, summarize } from '../server/benchmark/stats.js';

describe('stats', () => {
  it('interpolates percentiles', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 50)).toBe(30);
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 100)).toBe(50);
    expect(percentile(sorted, 90)).toBeCloseTo(46);
    expect(percentile([5], 99)).toBe(5);
  });

  it('summarizes unsorted values', () => {
    const s = summarize([30, 10, 20, 40, 50])!;
    expect(s).toMatchObject({ count: 5, min: 10, max: 50, mean: 30, p50: 30 });
    expect(s.stddev).toBeCloseTo(15.81, 1);
    expect(summarize([])).toBeNull();
  });

  it('computes P99 over 1..100', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = summarize(values)!;
    expect(s.p50).toBeCloseTo(50.5);
    expect(s.p95).toBeCloseTo(95.05);
    expect(s.p99).toBeCloseTo(99.01);
  });

  it('median handles empty and even sets', () => {
    expect(median([])).toBeNull();
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
