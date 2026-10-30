import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Copy, Download, RotateCw, Square, Trash2 } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import { ERROR_TYPES, type ErrorType, type RunDetail, type RunEndpointResult, type Sample, type Settings } from '../../../shared/schemas';
import { api, isActive, useInvalidate, useMutation, useRun, useSamples, useSettings } from '../api';
import { AXIS, GRID, Legend, MsTooltip, TooltipBox, TooltipRow } from '../components/charts';
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  HealthValue,
  Modal,
  PageHeader,
  RunStatusBadge,
  Segmented,
  SeverityIcon,
  Spinner,
  StatTile,
  Table,
  Td,
  Th,
} from '../components/ui';
import { fmtDuration, fmtMs, fmtNum, fmtPct, fmtTime, latencyHealth, successHealth } from '../format';
import { bucketize, download, samplesToCsv } from '../series';

export const ERROR_LABELS: Record<ErrorType, string> = {
  timeout: 'Timeout',
  network: 'Network',
  http: 'HTTP error',
  rate_limited: 'Rate limited',
  rpc_error: 'RPC error',
  invalid_response: 'Malformed',
  unexpected_result: 'Unexpected result',
};

/** Ranks endpoints within each network: usable success rate first, then P50. */
export function rankEndpoints(endpoints: RunEndpointResult[], availabilityMin: number) {
  const usable = (e: RunEndpointResult) => (e.successRate ?? 0) >= Math.min(availabilityMin, 0.9);
  const sorted = [...endpoints].sort((a, b) => {
    if (a.networkName !== b.networkName) return a.networkName.localeCompare(b.networkName);
    if (usable(a) !== usable(b)) return usable(a) ? -1 : 1;
    return (a.latency?.p50 ?? Infinity) - (b.latency?.p50 ?? Infinity);
  });
  const ranks = new Map<string, number>();
  let net = '';
  let r = 0;
  for (const e of sorted) {
    if (e.networkId !== net) {
      net = e.networkId;
      r = 0;
    }
    ranks.set(e.id, e.latency ? ++r : 0);
  }
  return { sorted, ranks };
}

export function RunDetailPage() {
  const { id = '' } = useParams();
  const run = useRun(id);
  const settings = useSettings();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = !!run.data && !isActive(run.data.status);
  const samples = useSamples(id, done);

  const cancel = useMutation({ mutationFn: () => api.cancelRun(id), onSuccess: () => invalidate('run', 'runs', 'dashboard') });
  const rerun = useMutation({
    mutationFn: () => api.rerun(id),
    onSuccess: async (r) => {
      await invalidate('runs', 'dashboard');
      navigate(`/results/${r.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRun(id),
    onSuccess: async () => {
      await invalidate('runs', 'dashboard', 'history');
      navigate('/results');
    },
  });

  if (run.isLoading) return <Spinner />;
  if (run.error || !run.data) return <ErrorBox error={run.error ?? 'Run not found'} />;
  const r = run.data;
  const t = settings.data?.thresholds;
  const { sorted, ranks } = rankEndpoints(r.endpoints, t?.availabilityMin ?? 0.99);
  const multiNetwork = new Set(r.endpoints.map((e) => e.networkId)).size > 1;
  const issueCount = r.endpoints.filter((e) => e.issues.some((i) => i.severity !== 'info')).length;
  const c = r.config;

  return (
    <>
      <PageHeader
        title={r.name || 'Benchmark run'}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <RunStatusBadge status={r.status} />
            <span>{fmtTime(r.createdAt)}</span>
            {r.startedAt && r.finishedAt && <span>Took {fmtDuration(r.finishedAt - r.startedAt)}</span>}
            <span className="font-mono text-xs text-muted" title="Run ID">
              {r.id.slice(0, 8)}
            </span>
          </span>
        }
        actions={
          isActive(r.status) ? (
            <Button variant="danger" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              <Square className="size-3.5" /> Cancel
            </Button>
          ) : (
            <>
              <Button
                onClick={() => samples.data && download(`rpc-pulse-${r.id.slice(0, 8)}.csv`, samplesToCsv(samples.data, new Map(r.endpoints.map((e) => [e.id, e.endpointName]))))}
                disabled={!samples.data?.length}
                title="Download raw request samples"
              >
                <Download className="size-3.5" /> CSV
              </Button>
              <Link to={`/benchmarks?from=${r.id}`}>
                <Button>
                  <Copy className="size-3.5" /> Edit & re-run
                </Button>
              </Link>
              <Button onClick={() => rerun.mutate()} loading={rerun.isPending} title="Run again with identical configuration">
                <RotateCw className="size-3.5" /> Re-run
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete run">
                <Trash2 className="size-3.5" />
              </Button>
            </>
          )
        }
      />
      <ErrorBox error={rerun.error ?? cancel.error} />
      {r.error && <ErrorBox error={r.error} />}

      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-xs text-ink-2">
        <ConfigItem label="Methods" value={c.methods.join(', ')} mono />
        <ConfigItem label="Requests/endpoint" value={c.requestsPerEndpoint !== null ? fmtNum(c.requestsPerEndpoint) : 'unlimited'} />
        <ConfigItem label="Duration" value={c.durationSec !== null ? `${c.durationSec}s` : 'unlimited'} />
        <ConfigItem label="Concurrency" value={c.concurrency} />
        <ConfigItem label="Interval" value={`${c.intervalMs} ms`} />
        <ConfigItem label="Timeout" value={`${c.timeoutMs} ms`} />
        <ConfigItem label="Warm-up" value={c.warmup ? 'on' : 'off'} />
      </div>

      {isActive(r.status) && <ProgressPanel run={r} />}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Fastest endpoint (P50)"
          value={r.bestEndpoint ? fmtMs(r.bestEndpoint.latencyP50) : '—'}
          sub={r.bestEndpoint ? `${r.bestEndpoint.name} · ${r.bestEndpoint.provider}` : 'No endpoint with ≥90% success'}
          health={latencyHealth(r.bestEndpoint?.latencyP50, t)}
        />
        <StatTile label="Overall success rate" value={fmtPct(r.successRate, 2)} health={successHealth(r.successRate, t)} sub={`${fmtNum(r.totalRequests)} measured requests`} />
        <StatTile label="Endpoints" value={r.endpointCount} sub={r.networks.join(', ')} />
        <StatTile label="Endpoints with issues" value={issueCount} health={done ? (issueCount === 0 ? 'good' : 'warning') : undefined} sub="Warnings or critical findings" />
      </div>

      <Card title="Provider comparison" className="mb-4" bodyClassName="">
        <ComparisonTable endpoints={sorted} ranks={ranks} thresholds={t} multiNetwork={multiNetwork} />
      </Card>

      {done && r.endpoints.some((e) => e.latency) && (
        <div className="mb-4 grid gap-4 xl:grid-cols-2">
          <PercentileChart endpoints={sorted.filter((e) => e.latency)} />
          <TimingBreakdown endpoints={sorted.filter((e) => e.latency)} />
        </div>
      )}

      {done && (
        <Card title="Latency over time" className="mb-4" actions={<span className="text-xs text-muted">Per-endpoint request latency across the run, in equal time buckets</span>}>
          {samples.isLoading ? <Spinner /> : samples.data?.length ? <LatencyTimeline endpoints={sorted} samples={samples.data} /> : <Empty title="No samples">Raw samples may have been removed by the retention policy.</Empty>}
        </Card>
      )}

      {done && (
        <div className="grid gap-4 xl:grid-cols-2">
          <ErrorBreakdown endpoints={sorted} samples={samples.data ?? []} />
          <ConsistencyPanel endpoints={sorted} />
        </div>
      )}

      <Modal
        title="Delete run"
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">This permanently deletes the run, its results and all raw samples.</p>
        <ErrorBox error={remove.error} />
      </Modal>
    </>
  );
}

function ConfigItem({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <span>
      {label}: <span className={clsx('text-ink', mono && 'font-mono')}>{value}</span>
    </span>
  );
}

function ProgressPanel({ run }: { run: RunDetail }) {
  const p = run.progress;
  const byDuration = run.config.durationSec !== null ? Math.min(1, (p?.elapsedMs ?? 0) / (run.config.durationSec * 1000)) : 0;
  const byCount = p?.expected ? p.completed / p.expected : 0;
  const fraction = run.status === 'queued' ? 0 : Math.max(byDuration, byCount);
  return (
    <Card className="mb-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium">{run.status === 'queued' ? 'Waiting for the current benchmark to finish…' : 'Benchmark in progress'}</span>
        <span className="tabular text-ink-2">
          {fmtNum(p?.completed ?? 0)}
          {p?.expected ? ` / ${fmtNum(p.expected)}` : ''} requests · {fmtDuration(p?.elapsedMs ?? 0)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {run.endpoints.map((e) => (
          <span key={e.id} className="rounded border border-line px-2 py-0.5 text-ink-2">
            {e.endpointName}: <span className="text-ink">{e.status}</span>
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Results are computed when all endpoints finish. You can leave this page; the run continues on the server.</p>
    </Card>
  );
}

/** Inline latency distribution: whisker min–P99, bar P50–P95, tick at P50. */
function LatencyRange({ e, max }: { e: RunEndpointResult; max: number }) {
  if (!e.latency || max <= 0) return <span className="text-muted">—</span>;
  const pos = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  const l = e.latency;
  return (
    <div className="relative h-4 w-40" title={`min ${fmtMs(l.min)} · P50 ${fmtMs(l.p50)} · P95 ${fmtMs(l.p95)} · P99 ${fmtMs(l.p99)}`}>
      <div className="absolute top-1/2 h-px bg-muted/60" style={{ left: pos(l.min), width: `calc(${pos(l.p99)} - ${pos(l.min)})` }} />
      <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-sm bg-accent/35" style={{ left: pos(l.p50), width: `max(2px, calc(${pos(l.p95)} - ${pos(l.p50)}))` }} />
      <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-accent" style={{ left: pos(l.p50) }} />
    </div>
  );
}

function ComparisonTable({
  endpoints,
  ranks,
  thresholds,
  multiNetwork,
}: {
  endpoints: RunEndpointResult[];
  ranks: Map<string, number>;
  thresholds: Settings['thresholds'] | undefined;
  multiNetwork: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const maxByNetwork = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of endpoints) m.set(e.networkId, Math.max(m.get(e.networkId) ?? 0, e.latency?.p99 ?? 0));
    return m;
  }, [endpoints]);

  return (
    <Table>
      <thead>
        <tr>
          <Th className="w-8" />
          <Th>#</Th>
          <Th>Endpoint</Th>
          <Th right>Success</Th>
          <Th right>P50</Th>
          <Th right>P95</Th>
          <Th right>P99</Th>
          <Th right>Mean</Th>
          <Th>
            Distribution <span className="font-normal">(min · P50–P95 · P99)</span>
          </Th>
          <Th right>Throughput</Th>
          <Th right>Block lag</Th>
          <Th>Issues</Th>
        </tr>
      </thead>
      <tbody>
        {endpoints.map((e, i) => {
          const showNetwork = multiNetwork && endpoints[i - 1]?.networkId !== e.networkId;
          const open = expanded === e.id;
          return (
            <Fragment key={e.id}>
              {showNetwork && (
                <tr className="bg-surface-2/50">
                  <td colSpan={12} className="px-3 py-1.5 text-xs font-medium text-ink-2">
                    {e.networkName}
                  </td>
                </tr>
              )}
              <tr className="cursor-pointer" onClick={() => setExpanded(open ? null : e.id)}>
                <Td className="text-muted">{e.methods.length > 0 && (open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />)}</Td>
                <Td className="tabular font-medium text-ink-2">{ranks.get(e.id) || '—'}</Td>
                <Td>
                  <div className="font-medium">{e.endpointName}</div>
                  <div className="text-xs text-ink-2">
                    {e.provider}
                    {e.status !== 'completed' && <span className="text-critical"> · {e.status}</span>}
                  </div>
                </Td>
                <Td right>
                  {e.successRate !== null ? <HealthValue health={successHealth(e.successRate, thresholds)}>{fmtPct(e.successRate)}</HealthValue> : '—'}
                  <div className="text-xs text-muted">
                    {fmtNum(e.success)}/{fmtNum(e.total)}
                  </div>
                </Td>
                <Td right>{e.latency ? <HealthValue health={latencyHealth(e.latency.p50, thresholds)}>{fmtMs(e.latency.p50)}</HealthValue> : '—'}</Td>
                <Td right>{fmtMs(e.latency?.p95)}</Td>
                <Td right>{fmtMs(e.latency?.p99)}</Td>
                <Td right>
                  {fmtMs(e.latency?.mean)}
                  {e.latency && <div className="text-xs text-muted">σ {fmtMs(e.latency.stddev)}</div>}
                </Td>
                <Td>
                  <LatencyRange e={e} max={maxByNetwork.get(e.networkId) ?? 0} />
                </Td>
                <Td right>
                  {e.throughputRps !== null ? `${fmtNum(e.throughputRps, 1)} rps` : '—'}
                  {e.windowMs !== null && <div className="text-xs text-muted">over {fmtDuration(e.windowMs)}</div>}
                </Td>
                <Td right>{e.blockLag === null ? '—' : e.blockLag === 0 ? '0' : <span className="font-medium">{e.blockLag}</span>}</Td>
                <Td>
                  <IssueSummary e={e} />
                </Td>
              </tr>
              {open && (
                <tr>
                  <td colSpan={12} className="bg-surface-2/40 px-3 py-3">
                    <MethodTable e={e} thresholds={thresholds} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}

function IssueSummary({ e }: { e: RunEndpointResult }) {
  if (e.error) return <span className="text-xs text-critical">{e.error}</span>;
  const shown = e.issues.filter((i) => i.severity !== 'info');
  if (shown.length === 0) return <span className="text-xs text-muted">None</span>;
  const worst = shown.some((i) => i.severity === 'critical') ? 'critical' : 'warning';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={shown.map((i) => i.message).join('\n')}>
      <SeverityIcon severity={worst} />
      {shown.length === 1 ? shown[0]!.code.replace(/_/g, ' ') : `${shown.length} issues`}
    </span>
  );
}

function MethodTable({ e, thresholds }: { e: RunEndpointResult; thresholds: Settings['thresholds'] | undefined }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-x-8 gap-y-1 text-xs text-ink-2 sm:grid-cols-2 lg:grid-cols-4">
        <span>
          URL: <span className="font-mono text-ink">{e.urlRedacted}</span>
        </span>
        <span>
          Network RTT (TCP): <span className="tabular text-ink">{fmtMs(e.networkRttMs)}</span>
        </span>
        <span>
          TTFB P50: <span className="tabular text-ink">{fmtMs(e.ttfb?.p50)}</span>
        </span>
        <span>
          Est. provider time: <span className="tabular text-ink">{fmtMs(e.providerTimeMs)}</span>
        </span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted">
            <th className="py-1 text-left font-medium">Method</th>
            <th className="py-1 text-right font-medium">Requests</th>
            <th className="py-1 text-right font-medium">Success</th>
            <th className="py-1 text-right font-medium">P50</th>
            <th className="py-1 text-right font-medium">P90</th>
            <th className="py-1 text-right font-medium">P95</th>
            <th className="py-1 text-right font-medium">P99</th>
            <th className="py-1 text-right font-medium">Max</th>
            <th className="py-1 pl-4 text-left font-medium">Errors</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {e.methods.map((m) => (
            <tr key={m.method} className="border-t border-line">
              <td className="py-1.5 font-mono">{m.method}</td>
              <td className="py-1.5 text-right">{fmtNum(m.total)}</td>
              <td className="py-1.5 text-right">
                <HealthValue health={successHealth(m.successRate, thresholds)}>{fmtPct(m.successRate)}</HealthValue>
              </td>
              <td className="py-1.5 text-right">{fmtMs(m.latency?.p50)}</td>
              <td className="py-1.5 text-right">{fmtMs(m.latency?.p90)}</td>
              <td className="py-1.5 text-right">{fmtMs(m.latency?.p95)}</td>
              <td className="py-1.5 text-right">{fmtMs(m.latency?.p99)}</td>
              <td className="py-1.5 text-right">{fmtMs(m.latency?.max)}</td>
              <td className="py-1.5 pl-4 text-ink-2">
                {Object.entries(m.errors)
                  .map(([k, v]) => `${ERROR_LABELS[k as ErrorType]} ${v}`)
                  .join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PercentileChart({ endpoints }: { endpoints: RunEndpointResult[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const data = endpoints.map((e) => ({ name: e.endpointName, p50: e.latency!.p50, p95: e.latency!.p95, p99: e.latency!.p99 }));
  const series = [
    { key: 'p50', label: 'P50', color: 'var(--series-1)' },
    { key: 'p95', label: 'P95', color: 'var(--series-2)' },
    { key: 'p99', label: 'P99', color: 'var(--series-3)' },
  ] as const;
  return (
    <Card title="Latency percentiles" actions={<Segmented value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />}>
      {view === 'chart' ? (
        <>
          <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
          <ResponsiveContainer width="100%" height={Math.max(160, data.length * 48 + 40)}>
            <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }} barGap={2} barCategoryGap="22%">
              <CartesianGrid stroke="var(--grid)" horizontal={false} />
              <XAxis type="number" {...AXIS} tickFormatter={(v: number) => fmtMs(v)} />
              <YAxis type="category" dataKey="name" {...AXIS} width={130} />
              <Tooltip content={<MsTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
              {series.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[0, 4, 4, 0]} maxBarSize={10} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </>
      ) : (
        <SimpleTable
          headers={['Endpoint', 'P50', 'P95', 'P99']}
          rows={data.map((d) => [d.name, fmtMs(d.p50), fmtMs(d.p95), fmtMs(d.p99)])}
        />
      )}
    </Card>
  );
}

/**
 * Splits median latency into network round trip (TCP connect), estimated
 * provider processing (TTFB − RTT) and response transfer/parsing (total − TTFB).
 */
function TimingBreakdown({ endpoints }: { endpoints: RunEndpointResult[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const data = endpoints.map((e) => {
    const total = e.latency!.p50;
    const ttfb = e.ttfb?.p50 ?? total;
    const network = e.networkRttMs !== null ? Math.min(e.networkRttMs, ttfb) : null;
    return {
      name: e.endpointName,
      network: network ?? 0,
      provider: network !== null ? Math.max(0, ttfb - network) : ttfb,
      transfer: Math.max(0, total - ttfb),
      total,
      hasRtt: network !== null,
    };
  });
  const series = [
    { key: 'network', label: 'Network RTT', color: 'var(--series-1)' },
    { key: 'provider', label: 'Provider processing (est.)', color: 'var(--series-2)' },
    { key: 'transfer', label: 'Transfer & parse', color: 'var(--series-3)' },
  ] as const;
  return (
    <Card title="Where the time goes (P50)" actions={<Segmented value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />}>
      {view === 'chart' ? (
        <>
          <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
          <ResponsiveContainer width="100%" height={Math.max(160, data.length * 40 + 40)}>
            <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }} barCategoryGap="30%">
              <CartesianGrid stroke="var(--grid)" horizontal={false} />
              <XAxis type="number" {...AXIS} tickFormatter={(v: number) => fmtMs(v)} />
              <YAxis type="category" dataKey="name" {...AXIS} width={130} />
              <Tooltip
                cursor={{ fill: 'var(--surface-2)' }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <TooltipBox title={String(label)}>
                      {payload.map((p) => (
                        <TooltipRow key={String(p.dataKey)} color={p.color} label={String(p.name)} value={fmtMs(p.value as number)} />
                      ))}
                      <TooltipRow label="Total P50" value={fmtMs((payload[0]!.payload as { total: number }).total)} />
                    </TooltipBox>
                  ) : null
                }
              />
              {series.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="t"
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                  radius={i === series.length - 1 ? [0, 4, 4, 0] : 0}
                  maxBarSize={16}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted">
            Network RTT is the median TCP handshake time to the host. Provider time is median time-to-first-byte minus RTT, on warm keep-alive connections.
          </p>
        </>
      ) : (
        <SimpleTable
          headers={['Endpoint', 'Network RTT', 'Provider (est.)', 'Transfer & parse', 'Total P50']}
          rows={data.map((d) => [d.name, d.hasRtt ? fmtMs(d.network) : '—', fmtMs(d.provider), fmtMs(d.transfer), fmtMs(d.total)])}
        />
      )}
    </Card>
  );
}

function LatencyTimeline({ endpoints, samples }: { endpoints: RunEndpointResult[]; samples: Sample[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const { perEndpoint, yMax } = useMemo(() => {
    const start = Math.min(...samples.map((s) => s.startedAt));
    const end = Math.max(...samples.map((s) => s.startedAt + s.totalMs));
    const groups = new Map<string, Sample[]>();
    for (const s of samples) groups.set(s.runEndpointId, [...(groups.get(s.runEndpointId) ?? []), s]);
    const perEndpoint = endpoints
      .filter((e) => groups.has(e.id))
      .map((e) => ({ e, buckets: bucketize(groups.get(e.id)!, start, end, 40) }));
    // Shared y-scale so small multiples are comparable; capped at overall P99-ish to keep outliers from flattening everything.
    const all = perEndpoint.flatMap((p) => p.buckets.map((b) => b.p95 ?? 0)).sort((a, b) => a - b);
    const yMax = all.length ? all[Math.floor(all.length * 0.98)]! * 1.15 : 1;
    return { perEndpoint, yMax };
  }, [endpoints, samples]);

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <Legend
          items={[
            { label: 'P50', color: 'var(--series-1)', shape: 'line' },
            { label: 'P95', color: 'var(--series-2)', shape: 'line' },
            { label: 'Bucket with failures', color: '#d03b3b' },
          ]}
        />
        <Segmented value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
      </div>
      {view === 'chart' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {perEndpoint.map(({ e, buckets }) => {
            const data = buckets.map((b) => ({ ...b, failMark: b.failures > 0 ? yMax * 0.97 : null }));
            return (
              <div key={e.id}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="font-medium">{e.endpointName}</span>
                  <span className="text-muted">{e.provider}</span>
                </div>
                <ResponsiveContainer width="100%" height={150}>
                  <ComposedChart data={data} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="t" {...AXIS} tickFormatter={(v: number) => `${v}s`} minTickGap={24} />
                    <YAxis {...AXIS} width={48} domain={[0, yMax]} allowDataOverflow tickFormatter={(v: number) => fmtMs(v)} tickCount={4} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const b = payload[0]!.payload as (typeof data)[number];
                        return (
                          <TooltipBox title={`${e.endpointName} · ~${b.t}s`}>
                            <TooltipRow color="var(--series-1)" label="P50" value={fmtMs(b.p50)} />
                            <TooltipRow color="var(--series-2)" label="P95" value={fmtMs(b.p95)} />
                            <TooltipRow label="Requests" value={b.requests} />
                            <TooltipRow color={b.failures ? '#d03b3b' : undefined} label="Failures" value={b.failures} />
                          </TooltipBox>
                        );
                      }}
                    />
                    <Line dataKey="p95" stroke="var(--series-2)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    <Line dataKey="p50" stroke="var(--series-1)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    <Scatter dataKey="failMark" fill="#d03b3b" shape="diamond" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <SimpleTable
            headers={['Endpoint', 'Time', 'Requests', 'Failures', 'P50', 'P95']}
            rows={perEndpoint.flatMap(({ e, buckets }) =>
              buckets.filter((b) => b.requests > 0).map((b) => [e.endpointName, `${b.t}s`, String(b.requests), String(b.failures), fmtMs(b.p50), fmtMs(b.p95)]),
            )}
          />
        </div>
      )}
    </>
  );
}

function ErrorBreakdown({ endpoints, samples }: { endpoints: RunEndpointResult[]; samples: Sample[] }) {
  const types = ERROR_TYPES.filter((t) => endpoints.some((e) => (e.errors[t] ?? 0) > 0));
  const messages = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const s of samples) {
      if (s.ok || !s.errorMessage) continue;
      const inner = m.get(s.runEndpointId) ?? new Map<string, number>();
      inner.set(s.errorMessage, (inner.get(s.errorMessage) ?? 0) + 1);
      m.set(s.runEndpointId, inner);
    }
    return m;
  }, [samples]);
  const failing = endpoints.filter((e) => e.failed > 0 || e.error);

  return (
    <Card title="Errors" bodyClassName="">
      {failing.length === 0 ? (
        <Empty title="No failed requests">Every measured request succeeded and returned a valid result.</Empty>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Endpoint</Th>
                {types.map((t) => (
                  <Th key={t} right>
                    {ERROR_LABELS[t]}
                  </Th>
                ))}
                <Th right>Total</Th>
              </tr>
            </thead>
            <tbody>
              {failing.map((e) => (
                <tr key={e.id}>
                  <Td className="font-medium">{e.endpointName}</Td>
                  {types.map((t) => (
                    <Td key={t} right className={e.errors[t] ? '' : 'text-muted'}>
                      {e.errors[t] ?? 0}
                    </Td>
                  ))}
                  <Td right className="font-medium">
                    {e.failed}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="space-y-3 border-t border-line px-4 py-3">
            <div className="text-xs font-medium text-ink-2">Most common error messages</div>
            {failing.map((e) => {
              const top = [...(messages.get(e.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 3);
              if (top.length === 0 && !e.error) return null;
              return (
                <div key={e.id} className="text-xs">
                  <div className="mb-0.5 font-medium">{e.endpointName}</div>
                  {e.error && <div className="font-mono text-critical">{e.error}</div>}
                  {top.map(([msg, n]) => (
                    <div key={msg} className="flex gap-2 font-mono text-ink-2">
                      <span className="tabular w-10 shrink-0 text-right text-muted">{n}×</span>
                      <span className="break-all">{msg}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

function ConsistencyPanel({ endpoints }: { endpoints: RunEndpointResult[] }) {
  return (
    <Card title="Consistency" bodyClassName="">
      <Table>
        <thead>
          <tr>
            <Th>Endpoint</Th>
            <Th right>Chain ID</Th>
            <Th right>Head block</Th>
            <Th right>Lag</Th>
            <Th>Client</Th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => {
            const mismatch = e.expectedChainId !== null && e.observedChainId !== null && e.observedChainId !== e.expectedChainId;
            return (
              <tr key={e.id}>
                <Td className="font-medium">{e.endpointName}</Td>
                <Td right className={mismatch ? 'font-medium text-critical' : ''}>
                  {e.observedChainId ?? '—'}
                </Td>
                <Td right>{e.headBlock?.toLocaleString() ?? '—'}</Td>
                <Td right>{e.blockLag ?? '—'}</Td>
                <Td className="max-w-56 truncate font-mono text-xs text-ink-2" title={e.clientVersion ?? undefined}>
                  {e.clientVersion ?? '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <div className="space-y-1.5 border-t border-line px-4 py-3">
        {endpoints.every((e) => e.issues.length === 0) ? (
          <div className="text-xs text-ink-2">No consistency issues detected.</div>
        ) : (
          endpoints.flatMap((e) =>
            e.issues.map((i) => (
              <div key={e.id + i.code} className="flex items-start gap-2 text-xs">
                <SeverityIcon severity={i.severity} className="mt-px size-3.5" />
                <span>
                  <span className="font-medium">{e.endpointName}:</span> <span className="text-ink-2">{i.message}</span>
                </span>
              </div>
            )),
          )
        )}
        <p className="pt-1 text-xs text-muted">
          Block lag compares simultaneous eth_blockNumber snapshots (3 rounds, median) across endpoints on the same network after the run.
        </p>
      </div>
    </Card>
  );
}

export function SimpleTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted">
          {headers.map((h, i) => (
            <th key={h} className={clsx('py-1.5 font-medium', i === 0 ? 'text-left' : 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular">
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-line">
            {r.map((c, j) => (
              <td key={j} className={clsx('py-1.5', j === 0 ? 'text-left font-medium' : 'text-right')}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
