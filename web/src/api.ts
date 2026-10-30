import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type {
  BenchmarkConfigInput,
  DashboardResponse,
  Endpoint,
  EndpointCreateInput,
  EndpointTestResult,
  EndpointUpdateInput,
  HistoryRange,
  HistoryResponse,
  Network,
  NetworkCreateInput,
  Paginated,
  RunDetail,
  RunSummary,
  Sample,
  Settings,
  SystemInfo,
} from '../../shared/schemas';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

const json = (method: string, data?: unknown): RequestInit => ({ method, body: data === undefined ? undefined : JSON.stringify(data) });

export const api = {
  system: () => request<SystemInfo>('/system'),
  dashboard: () => request<DashboardResponse>('/dashboard'),
  networks: () => request<Network[]>('/networks'),
  createNetwork: (input: NetworkCreateInput) => request<Network>('/networks', json('POST', input)),
  deleteNetwork: (id: string) => request<void>(`/networks/${id}`, json('DELETE')),
  endpoints: () => request<Endpoint[]>('/endpoints'),
  createEndpoint: (input: EndpointCreateInput) => request<Endpoint>('/endpoints', json('POST', input)),
  updateEndpoint: (id: string, input: EndpointUpdateInput) => request<Endpoint>(`/endpoints/${id}`, json('PATCH', input)),
  deleteEndpoint: (id: string) => request<void>(`/endpoints/${id}`, json('DELETE')),
  testEndpoint: (id: string) => request<EndpointTestResult>(`/endpoints/${id}/test`, json('POST')),
  testUrl: (url: string, networkId: string) => request<EndpointTestResult>('/endpoints/test', json('POST', { url, networkId })),
  runs: (params: { limit?: number; offset?: number; status?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return request<Paginated<RunSummary>>(`/runs?${q}`);
  },
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  samples: (id: string, runEndpointId?: string) =>
    request<Sample[]>(`/runs/${id}/samples?limit=20000${runEndpointId ? `&runEndpointId=${runEndpointId}` : ''}`),
  createRun: (config: BenchmarkConfigInput) => request<RunDetail>('/runs', json('POST', config)),
  cancelRun: (id: string) => request<{ ok: true }>(`/runs/${id}/cancel`, json('POST')),
  rerun: (id: string) => request<RunDetail>(`/runs/${id}/rerun`, json('POST')),
  deleteRun: (id: string) => request<void>(`/runs/${id}`, json('DELETE')),
  history: (range: HistoryRange, networkId?: string) =>
    request<HistoryResponse>(`/history?range=${range}${networkId ? `&networkId=${networkId}` : ''}`),
  settings: () => request<Settings>('/settings'),
  saveSettings: (s: Settings) => request<Settings>('/settings', json('PUT', s)),
};

export const isActive = (status: string) => status === 'queued' || status === 'running';

// --- Query hooks -------------------------------------------------------------

type Opts<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

export const useSystem = () => useQuery({ queryKey: ['system'], queryFn: api.system, staleTime: Infinity });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 });
export const useNetworks = () => useQuery({ queryKey: ['networks'], queryFn: api.networks });
export const useEndpoints = () => useQuery({ queryKey: ['endpoints'], queryFn: api.endpoints });

export const useDashboard = () =>
  useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
    refetchInterval: (q) => (q.state.data?.activeRun ? 2000 : 30_000),
  });

export const useRuns = (params: { limit: number; offset: number; status?: string }) =>
  useQuery({
    queryKey: ['runs', params],
    queryFn: () => api.runs(params),
    placeholderData: (prev) => prev,
    refetchInterval: (q) => (q.state.data?.items.some((r) => isActive(r.status)) ? 2000 : false),
  });

export const useRun = (id: string, opts?: Opts<RunDetail>) =>
  useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.status) ? 1000 : false),
    ...opts,
  });

export const useSamples = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ['samples', id], queryFn: () => api.samples(id), enabled, staleTime: Infinity });

export const useHistory = (range: HistoryRange, networkId?: string) =>
  useQuery({ queryKey: ['history', range, networkId], queryFn: () => api.history(range, networkId), placeholderData: (prev) => prev });

/** Invalidate everything derived from endpoints/runs after a mutation. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export { useMutation, useQueryClient };
