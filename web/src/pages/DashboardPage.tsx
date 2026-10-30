import { ArrowRight, Play, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { useDashboard, useSettings } from '../api';
import { groupByNetwork, Leaderboard } from '../components/Leaderboard';
import { Button, Card, Empty, ErrorBox, HealthValue, PageHeader, RunStatusBadge, Spinner, StatTile } from '../components/ui';
import { fmtMs, fmtPct, fmtRelative, latencyHealth, successHealth } from '../format';
import { IncidentList } from './HistoryPage';

export function DashboardPage() {
  const dash = useDashboard();
  const settings = useSettings();
  const t = settings.data?.thresholds;

  if (dash.isLoading) return <Spinner />;
  if (dash.error || !dash.data) return <ErrorBox error={dash.error} />;
  const d = dash.data;
  const healthy = d.leaderboard.filter((r) => (r.successRate ?? 0) >= (t?.availabilityMin ?? 0.99)).length;
  const networks = groupByNetwork(d.leaderboard);

  const actions = (
    <>
      <Link to="/endpoints">
        <Button>
          <Plus className="size-4" /> Endpoint
        </Button>
      </Link>
      <Link to="/benchmarks">
        <Button variant="primary">
          <Play className="size-4" /> New benchmark
        </Button>
      </Link>
    </>
  );

  if (d.counts.endpoints === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <Empty title="Welcome to RPC Pulse" action={actions}>
            Add the RPC endpoints you want to evaluate (Chainstack, Alchemy, QuickNode, Ankr, or your own nodes), then run a benchmark to compare latency, reliability and throughput.
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dashboard" description="Provider performance over the last 7 days, ranked per network." actions={actions} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Endpoints" value={d.counts.enabledEndpoints} sub={`${d.counts.endpoints} total · ${networks.length} network${networks.length === 1 ? '' : 's'} benchmarked`} />
        <StatTile
          label="Meeting availability target"
          value={d.leaderboard.length ? `${healthy}/${d.leaderboard.length}` : '—'}
          sub={`≥ ${fmtPct(t?.availabilityMin ?? 0.99)} success over 7 days`}
          health={d.leaderboard.length ? (healthy === d.leaderboard.length ? 'good' : 'warning') : undefined}
        />
        <StatTile label="Runs (24h)" value={d.counts.runsLast24h} sub={`${d.counts.runs} all time`} />
        <StatTile label="Incidents (7d)" value={d.incidents.length} health={d.leaderboard.length ? (d.incidents.length === 0 ? 'good' : 'warning') : undefined} sub="Spikes, outages, block lag" />
      </div>

      {networks.length === 0 ? (
        <Card className="mb-4">
          <Empty title="No benchmark results in the last 7 days" action={<Link to="/benchmarks"><Button variant="primary">Run a benchmark</Button></Link>}>
            Run a benchmark to see how your providers rank.
          </Empty>
        </Card>
      ) : (
        <div className="mb-4 space-y-4">
          {networks.map((n) => {
            const leader = n.rows[0]!;
            return (
              <Card
                key={n.networkId}
                title={n.networkName}
                bodyClassName=""
                actions={
                  n.rows.length > 1 && (
                    <span className="text-xs text-ink-2">
                      Leading: <span className="font-medium text-ink">{leader.endpointName}</span> at {fmtMs(leader.latencyP50)} P50
                    </span>
                  )
                }
              >
                <Leaderboard rows={n.rows} thresholds={t} />
              </Card>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          title="Recent runs"
          bodyClassName=""
          actions={
            <Link to="/results" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              All results <ArrowRight className="size-3" />
            </Link>
          }
        >
          {d.recentRuns.length === 0 ? (
            <Empty title="No runs yet" />
          ) : (
            <ul className="divide-y divide-line">
              {d.recentRuns.map((r) => (
                <li key={r.id}>
                  <Link to={`/results/${r.id}`} className="flex items-center gap-4 px-4 py-2.5 text-sm hover:bg-surface-2/60">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.name || 'Untitled benchmark'}</div>
                      <div className="text-xs text-ink-2">
                        {fmtRelative(r.createdAt)} · {r.endpointCount} endpoints · {r.networks.join(', ')}
                      </div>
                    </div>
                    {r.bestEndpoint && (
                      <div className="hidden text-right text-xs sm:block">
                        <HealthValue health={latencyHealth(r.bestEndpoint.latencyP50, t)}>{fmtMs(r.bestEndpoint.latencyP50)}</HealthValue>
                        <div className="text-ink-2">{r.bestEndpoint.name}</div>
                      </div>
                    )}
                    {r.successRate !== null && (
                      <div className="w-20 text-right text-xs">
                        <HealthValue health={successHealth(r.successRate, t)}>{fmtPct(r.successRate)}</HealthValue>
                      </div>
                    )}
                    <div className="w-24 text-right">
                      <RunStatusBadge status={r.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <IncidentList incidents={d.incidents} title="Recent incidents" />
      </div>
    </>
  );
}
