import { Lock, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, LIMITS, settingsSchema, type MethodId, type Settings } from '../../../shared/schemas';
import { api, useInvalidate, useMutation, useSettings, useSystem } from '../api';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Spinner, Toggle } from '../components/ui';

export function SettingsPage() {
  const settings = useSettings();
  const system = useSystem();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (s: Settings) => api.saveSettings(s),
    onSuccess: async (s) => {
      setForm(s);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await invalidate('settings', 'dashboard', 'history');
    },
  });

  if (!form) return <Spinner />;
  const parsed = settingsSchema.safeParse(form);
  const setD = <K extends keyof Settings['defaults']>(k: K, v: Settings['defaults'][K]) => setForm({ ...form, defaults: { ...form.defaults, [k]: v } });
  const setT = <K extends keyof Settings['thresholds']>(k: K, v: Settings['thresholds'][K]) => setForm({ ...form, thresholds: { ...form.thresholds, [k]: v } });
  const num = (v: string) => (v === '' ? NaN : Number(v));

  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <>
            <Button onClick={() => setForm(DEFAULT_SETTINGS)}>Reset to defaults</Button>
            <Button variant="primary" disabled={!parsed.success} loading={save.isPending} onClick={() => save.mutate(form)}>
              {saved ? 'Saved' : 'Save settings'}
            </Button>
          </>
        }
      />
      <div className="max-w-4xl space-y-4">
        {!parsed.success && <ErrorBox error={parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')} />}
        <ErrorBox error={save.error} />

        <Card title="Benchmark defaults">
          <p className="mb-4 text-xs text-ink-2">Pre-filled values for new benchmarks.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Requests per endpoint" hint="Empty = unlimited">
              <Input type="number" min={1} max={LIMITS.maxRequestsPerEndpoint} value={form.defaults.requestsPerEndpoint ?? ''} onChange={(e) => setD('requestsPerEndpoint', e.target.value ? Number(e.target.value) : null)} />
            </Field>
            <Field label="Duration (s)" hint="Empty = unlimited">
              <Input type="number" min={1} max={LIMITS.maxDurationSec} value={form.defaults.durationSec ?? ''} onChange={(e) => setD('durationSec', e.target.value ? Number(e.target.value) : null)} />
            </Field>
            <Field label="Concurrency">
              <Input type="number" min={1} max={LIMITS.maxConcurrency} value={form.defaults.concurrency} onChange={(e) => setD('concurrency', num(e.target.value))} />
            </Field>
            <Field label="Interval (ms)">
              <Input type="number" min={0} value={form.defaults.intervalMs} onChange={(e) => setD('intervalMs', num(e.target.value))} />
            </Field>
            <Field label="Timeout (ms)">
              <Input type="number" min={LIMITS.minTimeoutMs} max={LIMITS.maxTimeoutMs} value={form.defaults.timeoutMs} onChange={(e) => setD('timeoutMs', num(e.target.value))} />
            </Field>
            <Field label="Warm-up">
              <div className="flex h-8 items-center">
                <Toggle checked={form.defaults.warmup} onChange={(v) => setD('warmup', v)} label="Warm-up" />
              </div>
            </Field>
          </div>
          <div className="mt-4">
            <span className="mb-1.5 block text-xs font-medium text-ink-2">Default methods</span>
            <div className="flex flex-wrap gap-2">
              {system.data?.methods.map((m) => (
                <label key={m.id} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 font-mono text-xs">
                  <input
                    type="checkbox"
                    className="accent-[var(--series-1)]"
                    checked={form.defaults.methods.includes(m.id)}
                    onChange={() =>
                      setD('methods', form.defaults.methods.includes(m.id) ? form.defaults.methods.filter((x) => x !== m.id) : [...form.defaults.methods, m.id as MethodId])
                    }
                  />
                  {m.id}
                </label>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Thresholds">
          <p className="mb-4 text-xs text-ink-2">Used for health indicators, issue detection, rankings and incidents.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Healthy latency (ms)" hint="At or below: healthy">
              <Input type="number" min={1} value={form.thresholds.latencyGoodMs} onChange={(e) => setT('latencyGoodMs', num(e.target.value))} />
            </Field>
            <Field label="Degraded latency (ms)" hint="Above: poor">
              <Input type="number" min={1} value={form.thresholds.latencyWarnMs} onChange={(e) => setT('latencyWarnMs', num(e.target.value))} />
            </Field>
            <Field label="Availability target (%)" hint="Min success rate per run">
              <Input type="number" min={0} max={100} step={0.1} value={Math.round(form.thresholds.availabilityMin * 1000) / 10} onChange={(e) => setT('availabilityMin', num(e.target.value) / 100)} />
            </Field>
            <Field label="Block lag (blocks)" hint="Blocks behind before flagging">
              <Input type="number" min={1} value={form.thresholds.blockLagBlocks} onChange={(e) => setT('blockLagBlocks', num(e.target.value))} />
            </Field>
            <Field label="Spike factor (×)" hint="P95 vs endpoint's median P95">
              <Input type="number" min={1.1} step={0.1} value={form.thresholds.spikeFactor} onChange={(e) => setT('spikeFactor', num(e.target.value))} />
            </Field>
          </div>
        </Card>

        <Card title="Data retention">
          <Field label="Keep raw request samples (days)" hint="Older per-request samples are deleted; aggregated run results are kept indefinitely. 0 keeps everything." className="max-w-xs">
            <Input type="number" min={0} value={form.retention.sampleDays} onChange={(e) => setForm({ ...form, retention: { sampleDays: num(e.target.value) } })} />
          </Field>
        </Card>

        <Card title="Security">
          {system.data && (
            <ul className="space-y-3 text-sm">
              <li className="flex items-start gap-2.5">
                <Lock className="mt-0.5 size-4 text-ink-2" />
                <div>
                  <div className="font-medium">RPC URLs encrypted at rest (AES-256-GCM)</div>
                  <div className="text-xs text-ink-2">
                    {system.data.secretKeySource === 'env'
                      ? 'Key supplied via RPC_PULSE_SECRET_KEY.'
                      : 'Key is stored in a file next to the database. Set RPC_PULSE_SECRET_KEY in production so the key and data are kept separately.'}
                  </div>
                </div>
              </li>
              <li className="flex items-start gap-2.5">
                {system.data.allowPrivateNetworks ? <ShieldAlert className="mt-0.5 size-4 text-warning" /> : <ShieldCheck className="mt-0.5 size-4 text-good" />}
                <div>
                  <div className="font-medium">Private network access {system.data.allowPrivateNetworks ? 'allowed' : 'blocked'}</div>
                  <div className="text-xs text-ink-2">
                    {system.data.allowPrivateNetworks
                      ? 'Endpoints may target loopback and private addresses (ALLOW_PRIVATE_NETWORKS=true).'
                      : 'Endpoints resolving to loopback, private, link-local or reserved addresses are refused, checked on every connection. Set ALLOW_PRIVATE_NETWORKS=true on the server to benchmark local nodes.'}
                  </div>
                </div>
              </li>
            </ul>
          )}
          <p className="mt-4 text-xs text-muted">Security settings are controlled by server environment variables and cannot be changed from the UI.</p>
        </Card>

        {system.data && (
          <Card title="Limits">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              {Object.entries(system.data.limits).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-ink-2">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
                  <dd className="tabular">{v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">RPC Pulse v{system.data.version}</p>
          </Card>
        )}
      </div>
    </>
  );
}
