import { AlertTriangle, TrendingUp, WifiOff, Layers } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { HISTORY_RANGES, type HistoryPoint, type HistoryRange, type HistorySeries, type Incident } from '../../../shared/schemas';
import { useEndpoints, useHistory, useNetworks, useSettings } from '../api';
import { AXIS, GRID, Legend, TooltipBox, TooltipRow } from '../components/charts';
import { Leaderboard } from '../components/Leaderboard';
import { Card, Empty, ErrorBox, PageHeader, Segmented, Select, Spinner } from '../components/ui';
import { fmtMs, fmtNum, fmtPct, fmtRelative, fmtTime, seriesColor } from '../format';
import { SimpleTable } from './RunDetailPage';

type Metric = 'latencyP50' | 'latencyP95' | 'latencyMean' | 'throughputRps';
const METRICS: { value: Metric; label: string }[] = [
  { value: 'latencyP50', label: 'P50' },
  { value: 'latencyP95', label: 'P95' },
  { value: 'latencyMean', label: 'Mean' },
  { value: 'throughputRps', label: 'Throughput' },
];

/**
 * Stable colors per endpoint: slot by creation order within its network, so a
 * filter never repaints an endpoint. Slots are never cycled past 8.
 */
export function useEndpointColors(networkId: string | undefined) {
  const endpoints = useEndpoints();
  return useMemo(() => {
    const list = (endpoints.data ?? []).filter((e) => e.networkId === networkId).sort((a, b) => a.createdAt - b.createdAt);
    return new Map(list.map((e, i) => [e.id, seriesColor(i)]));
  }, [endpoints.data, networkId]);
}

export function HistoryPage() {
  const networks = useNetworks();
  const settings = useSettings();
  const [range, setRange] = useState<HistoryRange>('7d');
  const [networkId, setNetworkId] = useState<string>();
  const [metric, setMetric] = useState<Metric>('latencyP50');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const history = useHistory(range, networkId);
  const colors = useEndpointColors(networkId);

  // Default to the network with the most endpoints; latency is only comparable within a network.
  useEffect(() => {
    if (!networkId && networks.data?.length) {
      const best = [...networks.data].sort((a, b) => b.endpointCount - a.endpointCount)[0];
      setNetworkId(best?.id);
    }
  }, [networks.data, networkId]);

  const data = history.data;
  const t = settings.data?.thresholds;
  const metricLabel = METRICS.find((m) => m.value === metric)!.label;
  const fmtMetric = (v: number | null | undefined) => (metric === 'throughputRps' ? (v == null ? '—' : `${fmtNum(v, 1)} rps`) : fmtMs(v));

  return (
    <>
      <PageHeader title="History" description="Performance over time from completed benchmark runs. Compare providers on the same network across time ranges." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={networkId ?? ''} onChange={(e) => setNetworkId(e.target.value)} className="w-56" aria-label="Network">
          {networks.data?.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </Select>
        <Segmented value={range} onChange={setRange} options={HISTORY_RANGES.map((r) => ({ value: r, label: r }))} />
      </div>
      <ErrorBox error={history.error} />
      {!data ? (
        <Spinner />
      ) : data.series.length === 0 ? (
        <Card>
          <Empty title="No history for this network and range" action={<Link to="/benchmarks" className="text-sm text-accent hover:underline">Run a benchmark</Link>}>
            History builds up from completed benchmark runs. Run benchmarks regularly to track trends, spikes and availability.
          </Empty>
        </Card>
      ) : (
        <div className={history.isFetching ? 'opacity-70 transition-opacity' : ''}>
          <Card
            title={`${metricLabel} over time`}
            className="mb-4"
            actions={
              <>
                <Segmented value={metric} onChange={setMetric} options={METRICS} />
                <Segmented value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
              </>
            }
          >
            {view === 'chart' ? (
              <TrendChart series={data.series} colors={colors} from={data.from} to={data.to} valueKey={metric} format={fmtMetric} showSpikes={metric !== 'throughputRps'} />
            ) : (
              <PointsTable series={data.series} />
            )}
          </Card>
          <Card title="Success rate over time" className="mb-4">
            <TrendChart series={data.series} colors={colors} from={data.from} to={data.to} valueKey="successRate" format={(v) => fmtPct(v, 2)} percent />
          </Card>
          <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
            <Card title={`Ranking · last ${range}`} bodyClassName="">
              <Leaderboard rows={data.leaderboard} thresholds={t} colors={colors} />
            </Card>
            <IncidentList incidents={data.incidents} />
          </div>
        </div>
      )}
    </>
  );
}

function TrendChart({
  series,
  colors,
  from,
  to,
  valueKey,
  format,
  percent,
  showSpikes,
}: {
  series: HistorySeries[];
  colors: Map<string, string>;
  from: number;
  to: number;
  valueKey: keyof HistoryPoint;
  format: (v: number | null | undefined) => string;
  percent?: boolean;
  showSpikes?: boolean;
}) {
  const color = (s: HistorySeries) => colors.get(s.endpointId) ?? 'var(--muted)';
  // Legend and draw order follow color-slot order (endpoint creation order).
  const slot = (s: HistorySeries) => {
    const i = [...colors.keys()].indexOf(s.endpointId);
    return i === -1 ? Infinity : i;
  };
  series = [...series].sort((a, b) => slot(a) - slot(b));
  // One row per timestamp; each endpoint is a column, so a shared crosshair tooltip works.
  const rows = useMemo(() => {
    const byT = new Map<number, Record<string, number | boolean | null>>();
    for (const s of series) {
      for (const p of s.points) {
        const row = byT.get(p.t) ?? { t: p.t };
        row[s.endpointId] = p[valueKey] as number | null;
        if (p.spike) row[`${s.endpointId}:spike`] = true;
        byT.set(p.t, row);
      }
    }
    return [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number));
  }, [series, valueKey]);
  const dayRange = to - from <= 86_400_000;

  return (
    <>
      <Legend items={series.map((s) => ({ label: s.endpointName, color: color(s), shape: 'line' as const }))} />
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[from, to]}
            {...AXIS}
            tickFormatter={(v: number) =>
              new Date(v).toLocaleString(undefined, dayRange ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })
            }
            minTickGap={40}
          />
          <YAxis
            {...AXIS}
            width={58}
            domain={percent ? [(min: number) => Math.max(0, Math.floor(min * 100 - 1) / 100), 1] : [0, 'auto']}
            tickFormatter={(v: number) => (percent ? `${Math.round(v * 1000) / 10}%` : format(v))}
          />
          <Tooltip
            cursor={{ stroke: 'var(--axis)' }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipBox title={fmtTime(label as number)}>
                  {payload.map((p) => {
                    const spike = (p.payload as Record<string, unknown>)[`${String(p.dataKey)}:spike`];
                    return <TooltipRow key={String(p.dataKey)} color={p.color} label={`${p.name}${spike ? ' (spike)' : ''}`} value={format(p.value as number)} />;
                  })}
                </TooltipBox>
              ) : null
            }
          />
          {series.map((s) => (
            <Line
              key={s.endpointId}
              dataKey={s.endpointId}
              name={s.endpointName}
              stroke={color(s)}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
              activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }}
              dot={(props: { cx?: number; cy?: number; payload?: Record<string, unknown>; index?: number }) => {
                const spike = showSpikes && props.payload?.[`${s.endpointId}:spike`];
                const key = `${s.endpointId}-${props.index}`;
                if (props.cx == null || props.cy == null || props.payload?.[s.endpointId] == null) return <g key={key} />;
                return spike ? (
                  <circle key={key} cx={props.cx} cy={props.cy} r={5.5} fill={color(s)} stroke="var(--surface)" strokeWidth={2} />
                ) : (
                  <circle key={key} cx={props.cx} cy={props.cy} r={rows.length > 60 ? 0 : 2.5} fill={color(s)} />
                );
              }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {showSpikes && <p className="mt-1 text-xs text-muted">Large markers are latency spikes: run P95 above the spike factor × that endpoint's median P95.</p>}
    </>
  );
}

function PointsTable({ series }: { series: HistorySeries[] }) {
  const rows = series
    .flatMap((s) => s.points.map((p) => ({ s, p })))
    .sort((a, b) => b.p.t - a.p.t)
    .map(({ s, p }) => [
      <Link key="n" to={`/results/${p.runId}`} className="hover:underline">
        {s.endpointName} · {fmtTime(p.t)}
      </Link>,
      fmtMs(p.latencyP50),
      fmtMs(p.latencyP95),
      fmtPct(p.successRate),
      p.throughputRps === null ? '—' : fmtNum(p.throughputRps, 1),
      p.blockLag ?? '—',
      p.spike ? 'Yes' : '',
    ]);
  return (
    <div className="max-h-96 overflow-y-auto">
      <SimpleTable headers={['Run', 'P50', 'P95', 'Success', 'RPS', 'Lag', 'Spike']} rows={rows} />
    </div>
  );
}

const INCIDENT_ICON: Record<Incident['type'], React.ReactNode> = {
  latency_spike: <TrendingUp className="size-3.5 text-serious" aria-label="Latency spike" />,
  availability: <AlertTriangle className="size-3.5 text-warning" aria-label="Availability" />,
  unreachable: <WifiOff className="size-3.5 text-critical" aria-label="Unreachable" />,
  block_lag: <Layers className="size-3.5 text-warning" aria-label="Block lag" />,
};

export function IncidentList({ incidents, title = 'Incidents' }: { incidents: Incident[]; title?: string }) {
  return (
    <Card title={title} bodyClassName="">
      {incidents.length === 0 ? (
        <Empty title="No incidents">No latency spikes, availability drops or block lag in this range.</Empty>
      ) : (
        <ul className="max-h-[420px] divide-y divide-line overflow-y-auto">
          {incidents.map((i, idx) => (
            <li key={idx}>
              <Link to={`/results/${i.runId}`} className="flex items-start gap-2.5 px-4 py-2.5 text-sm hover:bg-surface-2/60">
                <span className="mt-0.5">{INCIDENT_ICON[i.type]}</span>
                <span className="min-w-0 flex-1">{i.message}</span>
                <span className="shrink-0 text-xs text-muted">{fmtRelative(i.t)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
