import { Trophy } from 'lucide-react';
import type { LeaderboardRow, Settings } from '../../../shared/schemas';
import { fmtMs, fmtNum, fmtPct, fmtRelative, latencyHealth, successHealth } from '../format';
import { HealthValue, Table, Td, Th } from './ui';

/** Per-network ranking table. Bars are a single series (P50), scaled within the network. */
export function Leaderboard({ rows, thresholds, colors }: { rows: LeaderboardRow[]; thresholds: Settings['thresholds'] | undefined; colors?: Map<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => r.latencyP50 ?? 0));
  return (
    <Table>
      <thead>
        <tr>
          <Th className="w-10">#</Th>
          <Th>Endpoint</Th>
          <Th right>P50</Th>
          <Th className="w-40" />
          <Th right>P95</Th>
          <Th right>Success</Th>
          <Th right>Availability</Th>
          <Th right>Avg lag</Th>
          <Th right>Runs</Th>
          <Th right>Last run</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.endpointId}>
            <Td className="tabular font-medium text-ink-2">
              {r.rank === 1 && rows.length > 1 ? <Trophy className="size-4 text-accent" aria-label="Rank 1" /> : r.rank}
            </Td>
            <Td>
              <div className="flex items-center gap-2">
                {colors && <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: colors.get(r.endpointId) ?? 'var(--muted)' }} />}
                <div>
                  <div className="font-medium">{r.endpointName}</div>
                  <div className="text-xs text-ink-2">{r.provider}</div>
                </div>
              </div>
            </Td>
            <Td right>
              <HealthValue health={latencyHealth(r.latencyP50, thresholds)}>{fmtMs(r.latencyP50)}</HealthValue>
            </Td>
            <Td>
              <div className="h-2 w-full rounded-sm bg-surface-2">
                <div className="h-2 rounded-r-[4px] bg-accent" style={{ width: `${((r.latencyP50 ?? 0) / max) * 100}%` }} />
              </div>
            </Td>
            <Td right>{fmtMs(r.latencyP95)}</Td>
            <Td right>
              <HealthValue health={successHealth(r.successRate, thresholds)}>{fmtPct(r.successRate, 2)}</HealthValue>
            </Td>
            <Td right>{fmtPct(r.availability, 0)}</Td>
            <Td right>{r.avgBlockLag === null ? '—' : fmtNum(r.avgBlockLag, 1)}</Td>
            <Td right>{r.runs}</Td>
            <Td right className="text-ink-2">
              {fmtRelative(r.lastSeen)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function groupByNetwork<T extends { networkId: string; networkName: string }>(rows: T[]) {
  const map = new Map<string, { networkName: string; rows: T[] }>();
  for (const r of rows) {
    const g = map.get(r.networkId) ?? { networkName: r.networkName, rows: [] };
    g.rows.push(r);
    map.set(r.networkId, g);
  }
  return [...map.entries()].map(([networkId, g]) => ({ networkId, ...g }));
}
