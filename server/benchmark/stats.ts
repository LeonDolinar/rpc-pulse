import type { LatencyStats } from '../../shared/schemas.js';

/** Percentile with linear interpolation between closest ranks. `sorted` must be ascending. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of empty set');
  if (p <= 0) return sorted[0]!;
  if (p >= 100) return sorted[sorted.length - 1]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const lower = sorted[lo]!;
  const upper = sorted[hi]!;
  return lower + (upper - lower) * (rank - lo);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return percentile([...values].sort((a, b) => a - b), 50);
}

const round = (n: number) => Math.round(n * 100) / 100;

export function summarize(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const mean = sorted.reduce((acc, v) => acc + v, 0) / count;
  const variance = count > 1 ? sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (count - 1) : 0;
  return {
    count,
    min: round(sorted[0]!),
    max: round(sorted[count - 1]!),
    mean: round(mean),
    stddev: round(Math.sqrt(variance)),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
  };
}
