import { and, count, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type {
  DashboardResponse,
  HistoryPoint,
  HistoryRange,
  HistoryResponse,
  HistorySeries,
  Incident,
  LeaderboardRow,
  Settings,
} from '../../shared/schemas.js';
import { median } from '../benchmark/stats.js';
import type { Db } from '../db/client.js';
import { benchmarkRuns, endpoints, networks, runEndpoints } from '../db/schema.js';
import { getActiveRun, listRuns } from './runs.js';

const RANGE_MS: Record<HistoryRange, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
  '90d': 90 * 24 * 3600_000,
};

const MAX_INCIDENTS = 50;

export function getHistory(
  db: Db,
  thresholds: Settings['thresholds'],
  range: HistoryRange,
  filter: { networkId?: string; endpointIds?: string[] } = {},
): HistoryResponse {
  const to = Date.now();
  const from = to - RANGE_MS[range];
  const conditions = [
    isNotNull(runEndpoints.endpointId),
    isNotNull(runEndpoints.finishedAt),
    gte(runEndpoints.finishedAt, from),
    inArray(runEndpoints.status, ['completed', 'failed']),
    eq(benchmarkRuns.status, 'completed'),
  ];
  if (filter.networkId) conditions.push(eq(runEndpoints.networkId, filter.networkId));
  if (filter.endpointIds?.length) conditions.push(inArray(runEndpoints.endpointId, filter.endpointIds));

  const rows = db
    .select({
      id: runEndpoints.id,
      runId: runEndpoints.runId,
      endpointId: runEndpoints.endpointId,
      snapshotName: runEndpoints.endpointName,
      snapshotProvider: runEndpoints.provider,
      currentName: endpoints.name,
      currentProvider: endpoints.provider,
      networkId: runEndpoints.networkId,
      networkName: runEndpoints.networkName,
      status: runEndpoints.status,
      finishedAt: runEndpoints.finishedAt,
      total: runEndpoints.total,
      success: runEndpoints.success,
      successRate: runEndpoints.successRate,
      latencyP50: runEndpoints.latencyP50,
      latencyP95: runEndpoints.latencyP95,
      latencyMean: runEndpoints.latencyMean,
      throughputRps: runEndpoints.throughputRps,
      blockLag: runEndpoints.blockLag,
    })
    .from(runEndpoints)
    .innerJoin(benchmarkRuns, eq(benchmarkRuns.id, runEndpoints.runId))
    .leftJoin(endpoints, eq(endpoints.id, runEndpoints.endpointId))
    .where(and(...conditions))
    .orderBy(runEndpoints.finishedAt)
    .all();

  type Row = (typeof rows)[number];
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const list = grouped.get(row.endpointId!) ?? [];
    list.push(row);
    grouped.set(row.endpointId!, list);
  }

  const series: HistorySeries[] = [];
  const leaderboard: LeaderboardRow[] = [];
  const incidents: Incident[] = [];

  for (const [endpointId, list] of grouped) {
    const last = list[list.length - 1]!;
    const endpointName = last.currentName ?? last.snapshotName;
    const provider = last.currentProvider ?? last.snapshotProvider;
    const p95s = list.map((r) => r.latencyP95).filter((v): v is number => v !== null);
    const baselineP95 = p95s.length >= 3 ? median(p95s) : null;

    const points: HistoryPoint[] = list.map((r) => {
      const spike = baselineP95 !== null && r.latencyP95 !== null && r.latencyP95 > baselineP95 * thresholds.spikeFactor;
      const t = r.finishedAt!;
      const base = { type: 'latency_spike' as const, endpointId, endpointName, runId: r.runId, t };
      if (r.status === 'failed' || (r.total > 0 && r.success === 0)) {
        incidents.push({ ...base, type: 'unreachable', message: `${endpointName} was unreachable` });
      } else if (r.successRate !== null && r.successRate < thresholds.availabilityMin) {
        incidents.push({ ...base, type: 'availability', message: `${endpointName} success rate ${(r.successRate * 100).toFixed(1)}%` });
      }
      if (spike) {
        incidents.push({
          ...base,
          message: `${endpointName} P95 ${Math.round(r.latencyP95!)} ms (${(r.latencyP95! / baselineP95!).toFixed(1)}× its median)`,
        });
      }
      if (r.blockLag !== null && r.blockLag > thresholds.blockLagBlocks) {
        incidents.push({ ...base, type: 'block_lag', message: `${endpointName} was ${r.blockLag} blocks behind` });
      }
      return {
        runId: r.runId,
        runEndpointId: r.id,
        t,
        latencyP50: r.latencyP50,
        latencyP95: r.latencyP95,
        latencyMean: r.latencyMean,
        successRate: r.successRate,
        throughputRps: r.throughputRps,
        blockLag: r.blockLag,
        spike,
      };
    });
    series.push({ endpointId, endpointName, provider, networkId: last.networkId, networkName: last.networkName, points });

    const totals = list.reduce((acc, r) => ({ total: acc.total + r.total, success: acc.success + r.success }), { total: 0, success: 0 });
    const lags = list.map((r) => r.blockLag).filter((v): v is number => v !== null);
    leaderboard.push({
      endpointId,
      endpointName,
      provider,
      networkId: last.networkId,
      networkName: last.networkName,
      runs: list.length,
      latencyP50: median(list.map((r) => r.latencyP50).filter((v): v is number => v !== null)),
      latencyP95: median(p95s),
      successRate: totals.total > 0 ? totals.success / totals.total : null,
      availability: list.filter((r) => (r.successRate ?? 0) >= thresholds.availabilityMin).length / list.length,
      avgBlockLag: lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : null,
      lastSeen: last.finishedAt!,
      rank: 0,
    });
  }

  rankLeaderboard(leaderboard, thresholds.availabilityMin);
  incidents.sort((a, b) => b.t - a.t);
  return { range, from, to, series, leaderboard, incidents: incidents.slice(0, MAX_INCIDENTS) };
}

/**
 * Ranks endpoints within each network: endpoints meeting the availability
 * threshold first, then by median P50 latency. Latency across different
 * networks is not comparable, so ranks restart per network.
 */
function rankLeaderboard(rows: LeaderboardRow[], availabilityMin: number) {
  const healthy = (r: LeaderboardRow) => (r.successRate ?? 0) >= availabilityMin;
  rows.sort((a, b) => {
    if (a.networkName !== b.networkName) return a.networkName.localeCompare(b.networkName);
    if (healthy(a) !== healthy(b)) return healthy(a) ? -1 : 1;
    return (a.latencyP50 ?? Infinity) - (b.latencyP50 ?? Infinity);
  });
  let network = '';
  let rank = 0;
  for (const row of rows) {
    if (row.networkId !== network) {
      network = row.networkId;
      rank = 0;
    }
    row.rank = ++rank;
  }
}

export function getDashboard(db: Db, thresholds: Settings['thresholds']): DashboardResponse {
  const history = getHistory(db, thresholds, '7d');
  const endpointRows = db.select({ enabled: endpoints.enabled }).from(endpoints).all();
  const dayAgo = Date.now() - RANGE_MS['24h'];
  return {
    counts: {
      endpoints: endpointRows.length,
      enabledEndpoints: endpointRows.filter((e) => e.enabled).length,
      networks: db.select({ n: count() }).from(networks).get()?.n ?? 0,
      runs: db.select({ n: count() }).from(benchmarkRuns).get()?.n ?? 0,
      runsLast24h: db.select({ n: count() }).from(benchmarkRuns).where(gte(benchmarkRuns.createdAt, dayAgo)).get()?.n ?? 0,
    },
    leaderboard: history.leaderboard,
    recentRuns: listRuns(db, { limit: 8, offset: 0 }).items,
    activeRun: getActiveRun(db),
    incidents: history.incidents.slice(0, 10),
  };
}

