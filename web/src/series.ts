import type { Sample } from '../../shared/schemas';

export interface Bucket {
  /** Seconds since the first request of the run. */
  t: number;
  requests: number;
  failures: number;
  p50: number | null;
  p95: number | null;
}

function pct(sorted: number[], p: number): number {
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/** Splits samples into equal time buckets across [start, end] and summarises each. */
export function bucketize(samples: Sample[], start: number, end: number, count = 40): Bucket[] {
  const span = Math.max(end - start, 1);
  const width = span / count;
  const groups = Array.from({ length: count }, () => ({ lat: [] as number[], requests: 0, failures: 0 }));
  for (const s of samples) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((s.startedAt - start) / width)));
    const g = groups[i]!;
    g.requests++;
    if (s.ok) g.lat.push(s.totalMs);
    else g.failures++;
  }
  return groups.map((g, i) => {
    const sorted = g.lat.sort((a, b) => a - b);
    return {
      t: Math.round(((i + 0.5) * width) / 100) / 10,
      requests: g.requests,
      failures: g.failures,
      p50: sorted.length ? Math.round(pct(sorted, 50) * 10) / 10 : null,
      p95: sorted.length ? Math.round(pct(sorted, 95) * 10) / 10 : null,
    };
  });
}

export function samplesToCsv(samples: Sample[], names: Map<string, string>): string {
  const header = ['endpoint', 'method', 'started_at_iso', 'started_at_ms', 'ttfb_ms', 'total_ms', 'ok', 'error_type', 'http_status', 'rpc_error_code', 'error_message', 'block_number'];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = samples.map((s) =>
    [
      names.get(s.runEndpointId) ?? s.runEndpointId,
      s.method,
      new Date(s.startedAt).toISOString(),
      s.startedAt.toFixed(3),
      s.ttfbMs?.toFixed(3),
      s.totalMs.toFixed(3),
      s.ok,
      s.errorType,
      s.httpStatus,
      s.rpcErrorCode,
      s.errorMessage,
      s.blockNumber,
    ]
      .map(esc)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

export function download(filename: string, content: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
