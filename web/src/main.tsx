import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import './styles.css';

// Route-level code splitting keeps the charting library off the initial load.
const BenchmarksPage = lazy(() => import('./pages/BenchmarksPage').then((m) => ({ default: m.BenchmarksPage })));
const ComparePage = lazy(() => import('./pages/ComparePage').then((m) => ({ default: m.ComparePage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const EndpointsPage = lazy(() => import('./pages/EndpointsPage').then((m) => ({ default: m.EndpointsPage })));
const HistoryPage = lazy(() => import('./pages/HistoryPage').then((m) => ({ default: m.HistoryPage })));
const ResultsPage = lazy(() => import('./pages/ResultsPage').then((m) => ({ default: m.ResultsPage })));
const RunDetailPage = lazy(() => import('./pages/RunDetailPage').then((m) => ({ default: m.RunDetailPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/endpoints', element: <EndpointsPage /> },
      { path: '/benchmarks', element: <BenchmarksPage /> },
      { path: '/results', element: <ResultsPage /> },
      { path: '/results/compare', element: <ComparePage /> },
      { path: '/results/:id', element: <RunDetailPage /> },
      { path: '/history', element: <HistoryPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <div className="py-20 text-center text-ink-2">Page not found</div> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
