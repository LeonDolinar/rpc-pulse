import { clsx } from 'clsx';
import { Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { benchmarkConfigSchema, LIMITS, type BenchmarkConfig, type MethodId } from '../../../shared/schemas';
import { api, useEndpoints, useInvalidate, useMutation, useNetworks, useRuns, useSettings, useSystem } from '../api';
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, RunStatusBadge, Spinner, Toggle } from '../components/ui';
import { fmtNum, fmtRelative } from '../format';

type Form = Omit<BenchmarkConfig, 'requestsPerEndpoint' | 'durationSec'> & {
  requestsPerEndpoint: number;
  durationSec: number;
  limitRequests: boolean;
  limitDuration: boolean;
};

const PRESETS: { id: string; label: string; description: string; apply: Partial<Form> }[] = [
  {
    id: 'quick',
    label: 'Quick check',
    description: '50 requests, low concurrency',
    apply: { requestsPerEndpoint: 50, limitRequests: true, limitDuration: true, durationSec: 30, concurrency: 2, intervalMs: 0 },
  },
  {
    id: 'standard',
    label: 'Standard',
    description: '200 requests, 4 concurrent',
    apply: { requestsPerEndpoint: 200, limitRequests: true, limitDuration: true, durationSec: 120, concurrency: 4, intervalMs: 0 },
  },
  {
    id: 'load',
    label: 'Load test',
    description: '60 s sustained, 20 concurrent',
    apply: { limitRequests: false, limitDuration: true, durationSec: 60, concurrency: 20, intervalMs: 0 },
  },
  {
    id: 'steady',
    label: 'Steady sampling',
    description: '1 request/s for 2 min',
    apply: { limitRequests: false, limitDuration: true, durationSec: 120, concurrency: 1, intervalMs: 1000 },
  },
];

export function BenchmarksPage() {
  const endpoints = useEndpoints();
  const networks = useNetworks();
  const settings = useSettings();
  const system = useSystem();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState<Form | null>(null);
  const active = useRuns({ limit: 10, offset: 0, status: undefined });

  // Initialise from settings defaults, or from an existing run when cloning (?from=<runId>).
  useEffect(() => {
    if (form || !settings.data || !endpoints.data) return;
    const d = settings.data.defaults;
    const enabled = endpoints.data.filter((e) => e.enabled).map((e) => e.id);
    const base: Form = {
      name: '',
      endpointIds: enabled,
      methods: d.methods,
      requestsPerEndpoint: d.requestsPerEndpoint ?? 100,
      durationSec: d.durationSec ?? 60,
      limitRequests: d.requestsPerEndpoint !== null,
      limitDuration: d.durationSec !== null,
      concurrency: d.concurrency,
      intervalMs: d.intervalMs,
      timeoutMs: d.timeoutMs,
      warmup: d.warmup,
    };
    const from = params.get('from');
    if (!from) return setForm(base);
    api
      .run(from)
      .then((run) => {
        const c = run.config;
        setForm({
          ...base,
          ...c,
          name: c.name,
          endpointIds: c.endpointIds.filter((id) => enabled.includes(id)),
          requestsPerEndpoint: c.requestsPerEndpoint ?? base.requestsPerEndpoint,
          durationSec: c.durationSec ?? base.durationSec,
          limitRequests: c.requestsPerEndpoint !== null,
          limitDuration: c.durationSec !== null,
        });
      })
      .catch(() => setForm(base));
  }, [form, settings.data, endpoints.data, params]);

  const config = useMemo(() => {
    if (!form) return null;
    const { limitRequests, limitDuration, ...rest } = form;
    return {
      ...rest,
      requestsPerEndpoint: limitRequests ? form.requestsPerEndpoint : null,
      durationSec: limitDuration ? form.durationSec : null,
    };
  }, [form]);
  const validation = useMemo(() => (config ? benchmarkConfigSchema.safeParse(config) : null), [config]);

  const start = useMutation({
    mutationFn: () => api.createRun(config!),
    onSuccess: async (run) => {
      await invalidate('runs', 'dashboard');
      navigate(`/results/${run.id}`);
    },
  });

  if (endpoints.isLoading || settings.isLoading || !form) return <Spinner />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const enabledEndpoints = (endpoints.data ?? []).filter((e) => e.enabled);
  const byNetwork = (networks.data ?? [])
    .map((n) => ({ network: n, endpoints: enabledEndpoints.filter((e) => e.networkId === n.id) }))
    .filter((g) => g.endpoints.length > 0);
  const methods = system.data?.methods ?? [];
  const issues = validation && !validation.success ? [...new Set(validation.error.issues.map((i) => i.message))] : [];
  const expected = form.limitRequests ? form.requestsPerEndpoint * form.endpointIds.length : null;
  const queue = (active.data?.items ?? []).filter((r) => r.status === 'queued' || r.status === 'running');

  if (enabledEndpoints.length === 0) {
    return (
      <>
        <PageHeader title="Benchmarks" />
        <Card>
          <Empty title="No enabled endpoints" action={<Link to="/endpoints"><Button variant="primary">Manage endpoints</Button></Link>}>
            Add or enable at least one RPC endpoint to run a benchmark.
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Benchmarks"
        description="Configure a benchmark. All selected endpoints are measured at the same time, so results are comparable under the same conditions."
      />
      {queue.length > 0 && (
        <Card className="mb-4" title="In progress" bodyClassName="divide-y divide-line">
          {queue.map((r) => (
            <Link key={r.id} to={`/results/${r.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-surface-2/60">
              <span className="font-medium">{r.name || 'Untitled benchmark'}</span>
              <span className="flex items-center gap-4 text-ink-2">
                {r.endpointCount} endpoints · {fmtRelative(r.createdAt)}
                <RunStatusBadge status={r.status} />
              </span>
            </Link>
          ))}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card
            title="Endpoints"
            actions={
              <span className="text-xs text-muted">
                {form.endpointIds.length} of {enabledEndpoints.length} selected
              </span>
            }
          >
            <div className="space-y-4">
              {byNetwork.map(({ network, endpoints: list }) => {
                const ids = list.map((e) => e.id);
                const all = ids.every((id) => form.endpointIds.includes(id));
                return (
                  <div key={network.id}>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium text-ink-2">{network.name}</span>
                      <button
                        className="text-xs text-accent hover:underline"
                        onClick={() =>
                          set('endpointIds', all ? form.endpointIds.filter((id) => !ids.includes(id)) : [...new Set([...form.endpointIds, ...ids])])
                        }
                      >
                        {all ? 'Clear' : 'Select all'}
                      </button>
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                      {list.map((e) => (
                        <CheckTile key={e.id} checked={form.endpointIds.includes(e.id)} onChange={() => set('endpointIds', toggleIn(form.endpointIds, e.id))}>
                          <div className="truncate font-medium">{e.name}</div>
                          <div className="truncate text-xs text-ink-2">{e.provider}</div>
                        </CheckTile>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Methods" actions={<span className="text-xs text-muted">Requests rotate round-robin through selected methods</span>}>
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {methods.map((m) => (
                <CheckTile key={m.id} checked={form.methods.includes(m.id)} onChange={() => set('methods', toggleIn<MethodId>(form.methods, m.id))}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{m.id}</span>
                    <span className="rounded bg-surface-2 px-1 text-[10px] text-muted uppercase">{m.category}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-2">{m.description}</div>
                </CheckTile>
              ))}
            </div>
          </Card>

          <Card title="Load profile">
            <div className="mb-4 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setForm((f) => (f ? { ...f, ...p.apply } : f))}
                  className="rounded-md border border-line px-3 py-1.5 text-left hover:bg-surface-2"
                >
                  <div className="text-xs font-medium">{p.label}</div>
                  <div className="text-[11px] text-ink-2">{p.description}</div>
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Requests per endpoint" hint={form.limitRequests ? `Max ${fmtNum(LIMITS.maxRequestsPerEndpoint)}` : 'Unlimited: runs until the duration elapses'}>
                <div className="flex items-center gap-2">
                  <Toggle checked={form.limitRequests} onChange={(v) => set('limitRequests', v)} label="Limit requests" />
                  <Input type="number" min={1} max={LIMITS.maxRequestsPerEndpoint} value={form.requestsPerEndpoint} disabled={!form.limitRequests} onChange={(e) => set('requestsPerEndpoint', Number(e.target.value))} />
                </div>
              </Field>
              <Field label="Duration (seconds)" hint={form.limitDuration ? `Upper bound per endpoint, max ${LIMITS.maxDurationSec}s` : 'Unlimited: runs until request count is reached'}>
                <div className="flex items-center gap-2">
                  <Toggle checked={form.limitDuration} onChange={(v) => set('limitDuration', v)} label="Limit duration" />
                  <Input type="number" min={1} max={LIMITS.maxDurationSec} value={form.durationSec} disabled={!form.limitDuration} onChange={(e) => set('durationSec', Number(e.target.value))} />
                </div>
              </Field>
              <Field label="Concurrency" hint="Parallel in-flight requests per endpoint">
                <Input type="number" min={1} max={LIMITS.maxConcurrency} value={form.concurrency} onChange={(e) => set('concurrency', Number(e.target.value))} />
              </Field>
              <Field label="Request interval (ms)" hint="Pause each worker takes between requests">
                <Input type="number" min={0} max={LIMITS.maxIntervalMs} value={form.intervalMs} onChange={(e) => set('intervalMs', Number(e.target.value))} />
              </Field>
              <Field label="Request timeout (ms)" hint="Requests exceeding this count as timeouts">
                <Input type="number" min={LIMITS.minTimeoutMs} max={LIMITS.maxTimeoutMs} value={form.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))} />
              </Field>
              <Field label="Warm-up" hint="Open connections before measuring (uncounted)">
                <div className="flex h-8 items-center">
                  <Toggle checked={form.warmup} onChange={(v) => set('warmup', v)} label="Warm-up" />
                </div>
              </Field>
            </div>
          </Card>
        </div>

        <div>
          <Card title="Run" className="lg:sticky lg:top-6">
            <div className="space-y-4">
              <Field label="Name (optional)">
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Mainnet providers, EU" maxLength={120} />
              </Field>
              <dl className="space-y-1.5 text-sm">
                <SummaryRow label="Endpoints" value={form.endpointIds.length} />
                <SummaryRow label="Methods" value={form.methods.length} />
                <SummaryRow label="Total requests" value={expected !== null ? fmtNum(expected) : 'Duration-bound'} />
                <SummaryRow label="Max in-flight" value={`${fmtNum(form.concurrency * form.endpointIds.length)} / ${LIMITS.maxTotalInFlight}`} />
                <SummaryRow
                  label="Max duration"
                  value={form.limitDuration ? `${form.durationSec}s` : 'Until requests complete'}
                />
              </dl>
              {issues.length > 0 && (
                <ul className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
                  {issues.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
              <ErrorBox error={start.error} />
              <Button variant="primary" className="w-full" disabled={!validation?.success} loading={start.isPending} onClick={() => start.mutate()}>
                <Play className="size-4" /> Start benchmark
              </Button>
              <p className="text-xs text-muted">
                Runs on the server and keeps going if you close this page. Benchmarks execute one at a time; additional runs are queued.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-2">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  );
}

function CheckTile({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label
      className={clsx(
        'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors',
        checked ? 'border-accent/60 bg-accent/5' : 'border-line hover:bg-surface-2/60',
      )}
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-0.5 accent-[var(--series-1)]" />
      <div className="min-w-0">{children}</div>
    </label>
  );
}
