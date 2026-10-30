import { clsx } from 'clsx';
import { Activity, BarChart3, Gauge, History, Monitor, Moon, Server, Settings, Sun, Timer } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useDashboard } from '../api';
import { Spinner } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/endpoints', label: 'Endpoints', icon: Server },
  { to: '/benchmarks', label: 'Benchmarks', icon: Timer },
  { to: '/results', label: 'Results', icon: BarChart3 },
  { to: '/history', label: 'History', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

type Theme = 'system' | 'light' | 'dark';

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('rpc-pulse-theme') as Theme | null) ?? 'system');
  useEffect(() => {
    if (theme === 'system') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('rpc-pulse-theme');
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem('rpc-pulse-theme', theme);
    }
  }, [theme]);
  return [theme, setTheme];
}

export function Layout() {
  const [theme, setTheme] = useTheme();
  const { data } = useDashboard();
  const active = data?.activeRun;
  const nextTheme: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex h-14 items-center gap-2 px-4">
          <div className="flex size-7 items-center justify-center rounded-md bg-accent text-white">
            <Activity className="size-4" strokeWidth={2.5} />
          </div>
          <span className="font-semibold tracking-tight">RPC Pulse</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
                  isActive ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        {active && (
          <NavLink to={`/results/${active.id}`} className="mx-2 mb-2 rounded-md border border-line px-3 py-2 text-xs hover:bg-surface-2">
            <div className="flex items-center gap-1.5 font-medium text-accent">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-accent" />
              </span>
              Benchmark {active.status}
            </div>
            <div className="mt-0.5 truncate text-ink-2">{active.name || `${active.endpointCount} endpoints`}</div>
          </NavLink>
        )}
        <div className="border-t border-line p-2">
          <button
            onClick={() => setTheme(nextTheme[theme])}
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
            title="Toggle theme"
          >
            <ThemeIcon className="size-4" />
            Theme: {theme[0]!.toUpperCase() + theme.slice(1)}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-6 py-6">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
