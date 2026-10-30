import { useQueries } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { RunDetail, RunEndpointResult } from '../../../shared/schemas';
import { api, useSettings } from '../api';
import { Card, ErrorBox, HealthValue, PageHeader, Spinner, Table, Td, Th } from '../components/ui';
import { fmtMs, fmtPct, fmtTime, latencyHealth, successHealth } from '../format';

/** Side-by-side comparison of the same endpoints across several runs. */
export function ComparePage() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, 4);
  const settings = useSettings();
  const queries = useQueries({ queries: ids.map((id) => ({ queryKey: ['run', id], queryFn: () => api.run(id) })) });
  const t = settings.data?.thresholds;

  if (queries.some((q) => q.isLoading)) return <Spinner />;
  const error = queries.find((q) => q.error)?.error;
  if (error) return <ErrorBox error={error} />;
  const runs = queries.map((q) => q.data!) as RunDetail[];

  // Rows keyed by endpoint id (falling back to the snapshot name for deleted endpoints).
  const keyOf = (e: RunEndpointResult) => e.endpointId ?? `name:${e.endpointName}`;
  const rows = new Map<string, { name: string; provider: string; network: string }>();
  for (const r of runs) for (const e of r.endpoints) if (!rows.has(keyOf(e))) rows.set(keyOf(e), { name: e.endpointName, provider: e.provider, network: e.networkName });
  const lookup = runs.map((r) => new Map(r.endpoints.map((e) => [keyOf(e), e])));

  const metrics: { label: string; render: (e: RunEndpointResult) => React.ReactNode }[] = [
    { label: 'P50', render: (e) => (e.latency ? <HealthValue health={latencyHealth(e.latency.p50, t)}>{fmtMs(e.latency.p50)}</HealthValue> : '—') },
    { label: 'P95', render: (e) => fmtMs(e.latency?.p95) },
    { label: 'Success', render: (e) => (e.successRate !== null ? <HealthValue health={successHealth(e.successRate, t)}>{fmtPct(e.successRate)}</HealthValue> : '—') },
  ];

  return (
    <>
      <PageHeader title="Compare runs" description={<Link to="/results" className="hover:underline">← Back to results</Link>} />
      <Card className="mb-4" bodyClassName="">
        <Table>
          <thead>
            <tr>
              <Th>Run</Th>
              <Th>Started</Th>
              <Th>Config</Th>
              <Th right>Success</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r, i) => (
              <tr key={r.id}>
                <Td>
                  <Link to={`/results/${r.id}`} className="font-medium hover:text-accent hover:underline">
                    {String.fromCharCode(65 + i)} · {r.name || 'Untitled benchmark'}
                  </Link>
                </Td>
                <Td className="text-ink-2">{fmtTime(r.createdAt)}</Td>
                <Td className="font-mono text-xs text-ink-2">
                  {r.config.methods.join(',')} · {r.config.requestsPerEndpoint ?? '∞'} req · {r.config.durationSec ?? '∞'}s · c={r.config.concurrency}
                </Td>
                <Td right>{fmtPct(r.successRate)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="Endpoints across runs" bodyClassName="">
        <Table>
          <thead>
            <tr>
              <Th>Endpoint</Th>
              <Th>Metric</Th>
              {runs.map((r, i) => (
                <Th key={r.id} right>
                  Run {String.fromCharCode(65 + i)}
                </Th>
              ))}
              {runs.length === 2 && <Th right>Change</Th>}
            </tr>
          </thead>
          <tbody>
            {[...rows.entries()].flatMap(([key, info]) =>
              metrics.map((m, mi) => {
                const cells = lookup.map((l) => l.get(key));
                let delta: React.ReactNode = null;
                if (runs.length === 2 && m.label === 'P50') {
                  const [a, b] = cells.map((c) => c?.latency?.p50);
                  if (a && b) {
                    const pct = ((b - a) / a) * 100;
                    delta = <span className={pct <= 0 ? 'text-success-text' : 'text-critical'}>{`${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}</span>;
                  }
                }
                return (
                  <tr key={key + m.label} className={mi > 0 ? '!border-t-0' : ''}>
                    <Td>
                      {mi === 0 && (
                        <>
                          <div className="font-medium">{info.name}</div>
                          <div className="text-xs text-ink-2">
                            {info.provider} · {info.network}
                          </div>
                        </>
                      )}
                    </Td>
                    <Td className="text-xs text-muted">{m.label}</Td>
                    {cells.map((c, i) => (
                      <Td key={i} right>
                        {c ? m.render(c) : <span className="text-muted">not in run</span>}
                      </Td>
                    ))}
                    {runs.length === 2 && <Td right>{delta}</Td>}
                  </tr>
                );
              }),
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
