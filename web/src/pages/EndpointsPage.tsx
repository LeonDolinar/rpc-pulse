import { CheckCircle2, Lock, Pencil, Plus, Trash2, XCircle, Zap } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Endpoint, EndpointTestResult, Network } from '../../../shared/schemas';
import { api, useEndpoints, useInvalidate, useMutation, useNetworks, useSettings } from '../api';
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  HealthValue,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Toggle,
} from '../components/ui';
import { fmtMs, fmtPct, fmtRelative, latencyHealth, successHealth } from '../format';

const PROVIDERS = ['Chainstack', 'Alchemy', 'QuickNode', 'Ankr', 'Infura', 'dRPC', 'PublicNode', 'Blast', 'Self-hosted'];

export function EndpointsPage() {
  const endpoints = useEndpoints();
  const networks = useNetworks();
  const settings = useSettings();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState<Endpoint | 'new' | null>(null);
  const [addingNetwork, setAddingNetwork] = useState(false);
  const [testing, setTesting] = useState<{ endpoint: Endpoint; result?: EndpointTestResult; error?: unknown } | null>(null);
  const [deleting, setDeleting] = useState<Endpoint | null>(null);

  const toggle = useMutation({
    mutationFn: (e: Endpoint) => api.updateEndpoint(e.id, { enabled: !e.enabled }),
    onSuccess: () => invalidate('endpoints', 'dashboard'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEndpoint(id),
    onSuccess: () => {
      setDeleting(null);
      return invalidate('endpoints', 'networks', 'dashboard');
    },
  });

  const runTest = async (endpoint: Endpoint) => {
    setTesting({ endpoint });
    try {
      setTesting({ endpoint, result: await api.testEndpoint(endpoint.id) });
    } catch (error) {
      setTesting({ endpoint, error });
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Endpoint[]>();
    for (const e of endpoints.data ?? []) map.set(e.networkId, [...(map.get(e.networkId) ?? []), e]);
    return (networks.data ?? []).filter((n) => map.has(n.id)).map((n) => ({ network: n, endpoints: map.get(n.id)! }));
  }, [endpoints.data, networks.data]);

  const t = settings.data?.thresholds;

  return (
    <>
      <PageHeader
        title="Endpoints"
        description="RPC providers and endpoints to benchmark. URLs are encrypted at rest and never shown in full."
        actions={
          <>
            <Button onClick={() => setAddingNetwork(true)}>Add network</Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add endpoint
            </Button>
          </>
        }
      />
      {(endpoints.isLoading || networks.isLoading) && <Spinner />}
      <ErrorBox error={endpoints.error ?? networks.error} />
      {endpoints.data?.length === 0 && (
        <Card>
          <Empty title="No endpoints yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Add your first endpoint</Button>}>
            Add RPC endpoints from providers like Chainstack, Alchemy, QuickNode or Ankr, or your own node, then benchmark them side by side.
          </Empty>
        </Card>
      )}
      <div className="space-y-4">
        {grouped.map(({ network, endpoints: list }) => (
          <Card
            key={network.id}
            title={
              <span className="flex items-center gap-2">
                {network.name}
                <span className="text-xs font-normal text-muted">
                  {network.chainId !== null ? `Chain ID ${network.chainId}` : 'No chain ID'} · {list.length} endpoint{list.length === 1 ? '' : 's'}
                </span>
              </span>
            }
            bodyClassName=""
          >
            <Table>
              <thead>
                <tr>
                  <Th>Endpoint</Th>
                  <Th>URL</Th>
                  <Th right>Last P50</Th>
                  <Th right>Last success</Th>
                  <Th>Last run</Th>
                  <Th>Enabled</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className={e.enabled ? '' : 'opacity-60'}>
                    <Td>
                      <div className="font-medium">{e.name}</div>
                      <div className="text-xs text-ink-2">
                        {e.provider}
                        {e.description && <span className="text-muted"> · {e.description}</span>}
                      </div>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-2" title="Credentials are masked">
                        <Lock className="size-3 text-muted" />
                        {e.urlRedacted}
                      </span>
                    </Td>
                    <Td right>
                      {e.lastRun ? <HealthValue health={latencyHealth(e.lastRun.latencyP50, t)}>{fmtMs(e.lastRun.latencyP50)}</HealthValue> : '—'}
                    </Td>
                    <Td right>
                      {e.lastRun ? <HealthValue health={successHealth(e.lastRun.successRate, t)}>{fmtPct(e.lastRun.successRate)}</HealthValue> : '—'}
                    </Td>
                    <Td className="text-ink-2">
                      {e.lastRun ? (
                        <Link className="hover:text-accent hover:underline" to={`/results/${e.lastRun.runId}`}>
                          {fmtRelative(e.lastRun.finishedAt)}
                        </Link>
                      ) : (
                        'Never'
                      )}
                    </Td>
                    <Td>
                      <Toggle checked={e.enabled} onChange={() => toggle.mutate(e)} label={`Enable ${e.name}`} />
                    </Td>
                    <Td right>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => runTest(e)} title="Test connection">
                          <Zap className="size-3.5" /> Test
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label={`Edit ${e.name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(e)} aria-label={`Delete ${e.name}`}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ))}
      </div>

      {editing && networks.data && (
        <EndpointForm
          endpoint={editing === 'new' ? null : editing}
          networks={networks.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            return invalidate('endpoints', 'networks', 'dashboard');
          }}
        />
      )}
      {addingNetwork && <NetworkForm onClose={() => setAddingNetwork(false)} onSaved={() => { setAddingNetwork(false); return invalidate('networks'); }} />}
      <Modal title={`Connection test · ${testing?.endpoint.name ?? ''}`} open={!!testing} onClose={() => setTesting(null)}>
        {testing && !testing.result && !testing.error && <Spinner label="Testing connection…" />}
        <ErrorBox error={testing?.error} />
        {testing?.result && <TestResultView result={testing.result} />}
      </Modal>
      <Modal
        title="Delete endpoint"
        open={!!deleting}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          Delete <span className="font-medium text-ink">{deleting?.name}</span>? Its stored URL is removed. Past benchmark results are kept and remain
          visible under the endpoint's name.
        </p>
        <ErrorBox error={remove.error} />
      </Modal>
    </>
  );
}

function TestResultView({ result }: { result: EndpointTestResult }) {
  const rows: [string, React.ReactNode][] = [
    ['Chain ID', result.chainId ?? '—'],
    [
      'Expected chain ID',
      result.expectedChainId === null ? 'Not set' : (
        <span className="inline-flex items-center gap-1">
          {result.expectedChainId}
          {result.chainIdMatches === true && <CheckCircle2 className="size-3.5 text-good" aria-label="Matches" />}
          {result.chainIdMatches === false && <XCircle className="size-3.5 text-critical" aria-label="Mismatch" />}
        </span>
      ),
    ],
    ['Latest block', result.blockNumber?.toLocaleString() ?? '—'],
    ['Client', result.clientVersion ?? '—'],
    ['Latency (eth_blockNumber, warm)', fmtMs(result.latencyMs)],
  ];
  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 text-sm font-medium ${result.ok ? 'text-success-text' : 'text-critical'}`}>
        {result.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
        {result.ok ? 'Endpoint is reachable and responding correctly' : 'Endpoint check failed'}
      </div>
      {result.error && <ErrorBox error={result.error} />}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-2">{k}</dt>
            <dd className="tabular break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">A single request is indicative only. Run a benchmark for statistically meaningful results.</p>
    </div>
  );
}

function EndpointForm({ endpoint, networks, onClose, onSaved }: { endpoint: Endpoint | null; networks: Network[]; onClose: () => void; onSaved: () => unknown }) {
  const [form, setForm] = useState({
    name: endpoint?.name ?? '',
    provider: endpoint?.provider ?? '',
    description: endpoint?.description ?? '',
    networkId: endpoint?.networkId ?? networks[0]?.id ?? '',
    url: '',
    enabled: endpoint?.enabled ?? true,
  });
  const [test, setTest] = useState<{ result?: EndpointTestResult; error?: unknown; loading?: boolean }>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      if (endpoint) {
        const { url, ...rest } = form;
        return api.updateEndpoint(endpoint.id, url.trim() ? { ...rest, url } : rest);
      }
      return api.createEndpoint(form);
    },
    onSuccess: () => onSaved(),
  });

  const runTest = async () => {
    setTest({ loading: true });
    try {
      setTest({ result: form.url.trim() ? await api.testUrl(form.url, form.networkId) : await api.testEndpoint(endpoint!.id) });
    } catch (error) {
      setTest({ error });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Modal
      title={endpoint ? `Edit ${endpoint.name}` : 'Add endpoint'}
      open
      onClose={onClose}
      wide
      footer={
        <>
          <Button type="button" onClick={runTest} loading={test.loading} disabled={!form.url.trim() && !endpoint}>
            <Zap className="size-3.5" /> Test connection
          </Button>
          <div className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="endpoint-form" loading={save.isPending}>
            {endpoint ? 'Save changes' : 'Add endpoint'}
          </Button>
        </>
      }
    >
      <form id="endpoint-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Chainstack Mainnet" required maxLength={80} autoFocus />
        </Field>
        <Field label="Provider">
          <Input value={form.provider} onChange={(e) => set('provider', e.target.value)} list="providers" placeholder="Chainstack" required maxLength={60} />
          <datalist id="providers">
            {PROVIDERS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
        <Field label="Network">
          <Select value={form.networkId} onChange={(e) => set('networkId', e.target.value)} required>
            {networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
                {n.chainId !== null ? ` (${n.chainId})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Enabled" hint="Disabled endpoints are excluded from new benchmarks.">
          <div className="flex h-8 items-center">
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
          </div>
        </Field>
        <Field
          label="RPC URL"
          className="col-span-2"
          hint={
            endpoint ? (
              <>
                Current: <span className="font-mono">{endpoint.urlRedacted}</span>. Leave blank to keep it.
              </>
            ) : (
              'HTTP(S) JSON-RPC URL including any API key. Stored encrypted; only a masked form is ever displayed.'
            )
          }
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://nd-123-456-789.p2pify.com/your-api-key"
            required={!endpoint}
            className="font-mono"
          />
        </Field>
        <Field label="Description (optional)" className="col-span-2">
          <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Dedicated node, EU region" maxLength={500} />
        </Field>
        {(test.result || test.error !== undefined) && (
          <div className="col-span-2 rounded-md border border-line bg-surface-2/50 p-3">
            <ErrorBox error={test.error} />
            {test.result && <TestResultView result={test.result} />}
          </div>
        )}
        <div className="col-span-2">
          <ErrorBox error={save.error} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function NetworkForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => unknown }) {
  const [name, setName] = useState('');
  const [chainId, setChainId] = useState('');
  const [isTestnet, setIsTestnet] = useState(false);
  const save = useMutation({
    mutationFn: () => api.createNetwork({ name, chainId: chainId ? Number(chainId) : null, isTestnet }),
    onSuccess: () => onSaved(),
  });
  return (
    <Modal
      title="Add network"
      open
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="network-form" loading={save.isPending}>
            Add network
          </Button>
        </>
      }
    >
      <form
        id="network-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Linea" required maxLength={80} autoFocus />
        </Field>
        <Field label="Chain ID" hint="Used to detect endpoints serving the wrong chain. Leave empty to skip the check.">
          <Input type="number" min={1} value={chainId} onChange={(e) => setChainId(e.target.value)} placeholder="59144" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Toggle checked={isTestnet} onChange={setIsTestnet} label="Testnet" /> Testnet
        </label>
        <ErrorBox error={save.error} />
      </form>
    </Modal>
  );
}
