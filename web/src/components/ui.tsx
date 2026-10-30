import { clsx } from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Info,
  Loader2,
  OctagonAlert,
  XCircle,
  X,
} from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { IssueSeverity, RunStatus } from '../../../shared/schemas';
import type { Health } from '../format';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-line bg-surface text-critical hover:bg-critical/10',
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(bodyClassName ?? 'p-4')}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatTile({ label, value, sub, health }: { label: string; value: ReactNode; sub?: ReactNode; health?: Health }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
        {health && health !== 'unknown' && <HealthIcon health={health} className="size-4.5" />}
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

const HEALTH_LABEL: Record<Health, string> = { good: 'Healthy', warning: 'Degraded', critical: 'Poor', unknown: 'No data' };

export function HealthIcon({ health, className }: { health: Health; className?: string }) {
  const cls = clsx('shrink-0', className ?? 'size-3.5');
  if (health === 'good') return <CheckCircle2 className={clsx(cls, 'text-good')} aria-label={HEALTH_LABEL.good} />;
  if (health === 'warning') return <AlertTriangle className={clsx(cls, 'text-warning')} aria-label={HEALTH_LABEL.warning} />;
  if (health === 'critical') return <XCircle className={clsx(cls, 'text-critical')} aria-label={HEALTH_LABEL.critical} />;
  return <CircleDashed className={clsx(cls, 'text-muted')} aria-label={HEALTH_LABEL.unknown} />;
}

/** A metric value with a status icon, so state is never conveyed by color alone. */
export function HealthValue({ health, children }: { health: Health; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 tabular" title={HEALTH_LABEL[health]}>
      <HealthIcon health={health} />
      {children}
    </span>
  );
}

const RUN_STATUS: Record<RunStatus, { label: string; cls: string; icon: ReactNode }> = {
  queued: { label: 'Queued', cls: 'text-ink-2', icon: <CircleDashed className="size-3.5" /> },
  running: { label: 'Running', cls: 'text-accent', icon: <Loader2 className="size-3.5 animate-spin" /> },
  completed: { label: 'Completed', cls: 'text-success-text', icon: <CheckCircle2 className="size-3.5" /> },
  failed: { label: 'Failed', cls: 'text-critical', icon: <XCircle className="size-3.5" /> },
  cancelled: { label: 'Cancelled', cls: 'text-ink-2', icon: <CircleSlash className="size-3.5" /> },
  interrupted: { label: 'Interrupted', cls: 'text-serious', icon: <OctagonAlert className="size-3.5" /> },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-medium', s.cls)}>
      {s.icon}
      {s.label}
    </span>
  );
}

export function SeverityIcon({ severity, className }: { severity: IssueSeverity; className?: string }) {
  const cls = clsx('shrink-0', className ?? 'size-3.5');
  if (severity === 'critical') return <XCircle className={clsx(cls, 'text-critical')} aria-label="Critical" />;
  if (severity === 'warning') return <AlertTriangle className={clsx(cls, 'text-warning')} aria-label="Warning" />;
  return <Info className={clsx(cls, 'text-muted')} aria-label="Info" />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-2">
      <Loader2 className="size-4 animate-spin" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-critical/30 bg-critical/5 px-3 py-2 text-sm text-critical">
      <XCircle className="mt-0.5 size-4 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ title, open, onClose, children, footer, wide }: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx('w-full rounded-lg border border-line bg-surface shadow-xl', wide ? 'max-w-2xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-critical">{error}</span> : hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  'h-8 rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputCls, !props.className?.match(/\bw-/) && 'w-full', props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputCls, 'pr-7', !props.className?.match(/\bw-/) && 'w-full', props.className)} />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        checked ? 'bg-accent' : 'bg-grid',
      )}
    >
      <span className={clsx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'h-6 rounded px-2.5 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface-2 text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Th({ children, className, right }: { children?: ReactNode; className?: string; right?: boolean }) {
  return <th className={clsx('h-9 px-3 text-xs font-medium whitespace-nowrap text-muted', right ? 'text-right' : 'text-left', className)}>{children}</th>;
}

export function Td({ children, className, right, title }: { children?: ReactNode; className?: string; right?: boolean; title?: string }) {
  return (
    <td title={title} className={clsx('h-10 px-3 whitespace-nowrap', right && 'text-right tabular', className)}>
      {children}
    </td>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx('w-full border-collapse text-sm [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_tbody_tr:hover]:bg-surface-2/60', className)}>{children}</table>
    </div>
  );
}
