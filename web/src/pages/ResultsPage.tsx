import { GitCompare } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useRuns, useSettings } from '../api';
import { Button, Card, Empty, ErrorBox, HealthValue, PageHeader, RunStatusBadge, Select, Spinner, Table, Td, Th } from '../components/ui';
import { fmtDuration, fmtMs, fmtNum, fmtPct, fmtTime, latencyHealth, successHealth } from '../format';

const PAGE = 25;
const MAX_COMPARE = 4;

export function ResultsPage() {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const runs = useRuns({ limit: PAGE, offset, status: status || undefined });
  const settings = useSettings();
  const navigate = useNavigate();
  const t = settings.data?.thresholds;
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_COMPARE ? [...s, id] : s));

  return (
    <>
      <PageHeader
        title="Results"
        description="Every benchmark run with its results. Select up to four runs to compare them side by side."
        actions={
          <>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setOffset(0);
              }}
              className="w-40"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {['completed', 'running', 'queued', 'cancelled', 'failed', 'interrupted'].map((s) => (
                <option key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
            <Button variant="primary" disabled={selected.length < 2} onClick={() => navigate(`/results/compare?ids=${selected.join(',')}`)}>
              <GitCompare className="size-4" /> Compare{selected.length ? ` (${selected.length})` : ''}
            </Button>
          </>
        }
      />
      <ErrorBox error={runs.error} />
      <Card bodyClassName="">
        {runs.isLoading ? (
          <Spinner />
        ) : runs.data?.items.length === 0 ? (
          <Empty title="No benchmark runs" action={<Link to="/benchmarks"><Button variant="primary">Run a benchmark</Button></Link>} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-8" />
                  <Th>Run</Th>
                  <Th>Status</Th>
                  <Th>Networks</Th>
                  <Th right>Endpoints</Th>
                  <Th right>Requests</Th>
                  <Th right>Success</Th>
                  <Th>Fastest (P50)</Th>
                  <Th right>Duration</Th>
                </tr>
              </thead>
              <tbody>
                {runs.data?.items.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name || r.id} for comparison`}
                        checked={selected.includes(r.id)}
                        disabled={r.status !== 'completed' || (!selected.includes(r.id) && selected.length >= MAX_COMPARE)}
                        onChange={() => toggle(r.id)}
                        className="accent-[var(--series-1)]"
                      />
                    </Td>
                    <Td>
                      <Link to={`/results/${r.id}`} className="font-medium hover:text-accent hover:underline">
                        {r.name || 'Untitled benchmark'}
                      </Link>
                      <div className="text-xs text-ink-2">
                        {fmtTime(r.createdAt)} · {r.config.methods.length} method{r.config.methods.length === 1 ? '' : 's'} · c={r.config.concurrency}
                        {r.trigger === 'scheduled' && ' · scheduled'}
                      </div>
                    </Td>
                    <Td>
                      <RunStatusBadge status={r.status} />
                    </Td>
                    <Td className="text-ink-2">{r.networks.join(', ')}</Td>
                    <Td right>{r.endpointCount}</Td>
                    <Td right>{fmtNum(r.totalRequests)}</Td>
                    <Td right>{r.successRate !== null ? <HealthValue health={successHealth(r.successRate, t)}>{fmtPct(r.successRate)}</HealthValue> : '—'}</Td>
                    <Td>
                      {r.bestEndpoint ? (
                        <span className="inline-flex items-center gap-2">
                          <HealthValue health={latencyHealth(r.bestEndpoint.latencyP50, t)}>{fmtMs(r.bestEndpoint.latencyP50)}</HealthValue>
                          <span className="text-ink-2">{r.bestEndpoint.name}</span>
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td right>{r.startedAt && r.finishedAt ? fmtDuration(r.finishedAt - r.startedAt) : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-ink-2">
              <span>
                {offset + 1}–{Math.min(offset + PAGE, runs.data?.total ?? 0)} of {runs.data?.total ?? 0}
              </span>
              <div className="flex gap-2">
                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                <Button size="sm" disabled={offset + PAGE >= (runs.data?.total ?? 0)} onClick={() => setOffset(offset + PAGE)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
