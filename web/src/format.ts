import type { Settings } from '../../shared/schemas';

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(1)} ms`;
}

export function fmtPct(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined) return '—';
  if (rate === 1) return '100%';
  return `${(rate * 100).toFixed(digits)}%`;
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtTime(t: number | null | undefined): string {
  if (!t) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(t: number | null | undefined): string {
  if (!t) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export type Health = 'good' | 'warning' | 'critical' | 'unknown';

export function latencyHealth(ms: number | null | undefined, t: Settings['thresholds'] | undefined): Health {
  if (ms === null || ms === undefined || !t) return 'unknown';
  if (ms <= t.latencyGoodMs) return 'good';
  if (ms <= t.latencyWarnMs) return 'warning';
  return 'critical';
}

export function successHealth(rate: number | null | undefined, t: Settings['thresholds'] | undefined): Health {
  if (rate === null || rate === undefined || !t) return 'unknown';
  if (rate >= t.availabilityMin) return 'good';
  if (rate >= 0.9) return 'warning';
  return 'critical';
}

/** Categorical slot colors in fixed order. Never cycled: index >= 8 gets neutral. */
export const SERIES = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
export const seriesColor = (index: number) => SERIES[index] ?? 'var(--muted)';
