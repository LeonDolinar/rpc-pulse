import type { ReactNode } from 'react';
import type { TooltipContentProps } from 'recharts';
import { fmtMs } from '../format';

export const AXIS = {
  stroke: 'var(--axis)',
  tick: { fill: 'var(--muted)', fontSize: 11 },
  tickLine: false,
} as const;

export const GRID = { stroke: 'var(--grid)', vertical: false } as const;

/** Legend rendered in HTML above the chart; always present for >= 2 series. */
export function Legend({ items }: { items: { label: string; color: string; shape?: 'line' | 'square' }[] }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.shape === 'line' ? (
            <span className="inline-block h-0.5 w-3.5 rounded" style={{ background: i.color }} />
          ) : (
            <span className="inline-block size-2.5 rounded-sm" style={{ background: i.color }} />
          )}
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function TooltipBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-40 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function TooltipRow({ color, label, value }: { color?: string; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        {color && <span className="inline-block size-2 rounded-sm" style={{ background: color }} />}
        {label}
      </span>
      <span className="tabular font-medium text-ink">{value}</span>
    </div>
  );
}

/** Generic tooltip listing each series' value formatted as milliseconds. */
export function MsTooltip({ active, payload, label, labelFormatter }: Partial<TooltipContentProps<number, string>> & { labelFormatter?: (l: unknown) => ReactNode }) {
  if (!active || !payload?.length) return null;
  return (
    <TooltipBox title={labelFormatter ? labelFormatter(label) : String(label)}>
      {payload.map((p) => (
        <TooltipRow key={String(p.dataKey)} color={p.color} label={String(p.name)} value={fmtMs(p.value as number)} />
      ))}
    </TooltipBox>
  );
}
