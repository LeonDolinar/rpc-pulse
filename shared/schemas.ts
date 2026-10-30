import { z } from 'zod';

// ---------------------------------------------------------------------------
// Limits shared by the API validation layer and the UI forms.
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxEndpointsPerRun: 20,
  maxRequestsPerEndpoint: 10_000,
  maxDurationSec: 600,
  maxConcurrency: 50,
  /** Upper bound on concurrency × endpoints, i.e. total in-flight requests. */
  maxTotalInFlight: 250,
  maxIntervalMs: 60_000,
  minTimeoutMs: 500,
  maxTimeoutMs: 60_000,
} as const;

// ---------------------------------------------------------------------------
// Benchmark methods
// ---------------------------------------------------------------------------

export const METHOD_IDS = [
  'eth_chainId',
  'eth_blockNumber',
  'net_version',
  'web3_clientVersion',
  'eth_gasPrice',
  'eth_getBlockByNumber',
] as const;
export const methodIdSchema = z.enum(METHOD_IDS);
export type MethodId = z.infer<typeof methodIdSchema>;

export type MethodCategory = 'connectivity' | 'performance';

export interface MethodInfo {
  id: MethodId;
  label: string;
  category: MethodCategory;
  description: string;
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export const networkCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  chainId: z.number().int().positive().max(2 ** 53 - 1).nullable(),
  isTestnet: z.boolean().default(false),
});
export type NetworkCreateInput = z.infer<typeof networkCreateSchema>;

export interface Network {
  id: string;
  name: string;
  slug: string;
  chainId: number | null;
  isTestnet: boolean;
  endpointCount: number;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const urlField = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2048, 'URL is too long');

export const endpointCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional().default(''),
  networkId: z.string().min(1),
  url: urlField,
  enabled: z.boolean().optional().default(true),
});
export type EndpointCreateInput = z.input<typeof endpointCreateSchema>;

export const endpointUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(60),
    description: z.string().trim().max(500),
    networkId: z.string().min(1),
    /** Supplying a URL replaces the stored (encrypted) URL. Omit to keep it. */
    url: urlField,
    enabled: z.boolean(),
  })
  .partial();
export type EndpointUpdateInput = z.infer<typeof endpointUpdateSchema>;

export interface Endpoint {
  id: string;
  name: string;
  provider: string;
  description: string;
  networkId: string;
  networkName: string;
  /** URL with credentials masked. The full URL is never returned by the API. */
  urlRedacted: string;
  host: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRun: EndpointLastRun | null;
}

export interface EndpointLastRun {
  runId: string;
  finishedAt: number;
  successRate: number | null;
  latencyP50: number | null;
}

export interface EndpointTestResult {
  ok: boolean;
  chainId: number | null;
  expectedChainId: number | null;
  chainIdMatches: boolean | null;
  blockNumber: number | null;
  clientVersion: string | null;
  latencyMs: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Benchmark runs
// ---------------------------------------------------------------------------

export const benchmarkConfigSchema = z
  .object({
    name: z.string().trim().max(120).optional().default(''),
    endpointIds: z
      .array(z.string().min(1))
      .min(1, 'Select at least one endpoint')
      .max(LIMITS.maxEndpointsPerRun),
    methods: z.array(methodIdSchema).min(1, 'Select at least one method'),
    /** Requests per endpoint. Null means "until the duration elapses". */
    requestsPerEndpoint: z.number().int().min(1).max(LIMITS.maxRequestsPerEndpoint).nullable(),
    /** Maximum run time per endpoint in seconds. Null means "until request count is reached". */
    durationSec: z.number().int().min(1).max(LIMITS.maxDurationSec).nullable(),
    concurrency: z.number().int().min(1).max(LIMITS.maxConcurrency),
    /** Delay each worker waits between consecutive requests. */
    intervalMs: z.number().int().min(0).max(LIMITS.maxIntervalMs),
    timeoutMs: z.number().int().min(LIMITS.minTimeoutMs).max(LIMITS.maxTimeoutMs),
    /** Open connections with uncounted requests before measuring. */
    warmup: z.boolean().default(true),
  })
  .refine((c) => c.requestsPerEndpoint !== null || c.durationSec !== null, {
    message: 'Set a request count, a duration, or both',
    path: ['requestsPerEndpoint'],
  })
  .refine((c) => new Set(c.endpointIds).size === c.endpointIds.length, {
    message: 'Duplicate endpoints',
    path: ['endpointIds'],
  })
  .refine((c) => c.concurrency * c.endpointIds.length <= LIMITS.maxTotalInFlight, {
    message: `Concurrency × endpoints must not exceed ${LIMITS.maxTotalInFlight}`,
    path: ['concurrency'],
  });
export type BenchmarkConfigInput = z.input<typeof benchmarkConfigSchema>;
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type RunTrigger = 'manual' | 'scheduled';
export type RunEndpointStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export const ERROR_TYPES = [
  'timeout',
  'network',
  'http',
  'rate_limited',
  'rpc_error',
  'invalid_response',
  'unexpected_result',
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export type ErrorBreakdown = Partial<Record<ErrorType, number>>;

export type IssueSeverity = 'info' | 'warning' | 'critical';
export type IssueCode =
  | 'unreachable'
  | 'chain_id_mismatch'
  | 'chain_id_inconsistent'
  | 'net_version_mismatch'
  | 'block_lag'
  | 'block_regression'
  | 'high_error_rate'
  | 'rate_limited';

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
}

export interface MethodStats {
  method: MethodId;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  latency: LatencyStats | null;
  errors: ErrorBreakdown;
}

export interface RunEndpointResult {
  id: string;
  endpointId: string | null;
  endpointName: string;
  provider: string;
  networkId: string;
  networkName: string;
  expectedChainId: number | null;
  urlRedacted: string;
  status: RunEndpointStatus;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Wall-clock span of measured requests (first start → last completion). */
  windowMs: number | null;
  total: number;
  success: number;
  failed: number;
  successRate: number | null;
  /** Completed requests per second over the measured window. */
  throughputRps: number | null;
  /** Successful requests per second over the measured window. */
  successRps: number | null;
  /** End-to-end request latency (request sent → body parsed). */
  latency: LatencyStats | null;
  /** Time to first response byte (headers received). */
  ttfb: LatencyStats | null;
  /** Median TCP connect round-trip time to the endpoint host: approximates pure network latency. */
  networkRttMs: number | null;
  /** Estimated provider processing time: median TTFB minus median network RTT. */
  providerTimeMs: number | null;
  errors: ErrorBreakdown;
  observedChainId: number | null;
  clientVersion: string | null;
  headBlock: number | null;
  blockLag: number | null;
  issues: Issue[];
  methods: MethodStats[];
}

export interface RunSummary {
  id: string;
  name: string;
  status: RunStatus;
  trigger: RunTrigger;
  config: BenchmarkConfig;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  endpointCount: number;
  networks: string[];
  totalRequests: number;
  successRate: number | null;
  bestEndpoint: { name: string; provider: string; latencyP50: number } | null;
}

export interface RunDetail extends RunSummary {
  endpoints: RunEndpointResult[];
  progress: RunProgress | null;
}

export interface RunProgress {
  completed: number;
  /** Expected total when bounded by request count; null for duration-only runs. */
  expected: number | null;
  elapsedMs: number;
}

export interface Sample {
  runEndpointId: string;
  method: MethodId;
  /** Unix epoch milliseconds (fractional) when the request was sent. */
  startedAt: number;
  ttfbMs: number | null;
  totalMs: number;
  ok: boolean;
  errorType: ErrorType | null;
  httpStatus: number | null;
  rpcErrorCode: number | null;
  errorMessage: string | null;
  blockNumber: number | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

// ---------------------------------------------------------------------------
// History / dashboard
// ---------------------------------------------------------------------------

export const HISTORY_RANGES = ['24h', '7d', '30d', '90d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export interface HistoryPoint {
  runId: string;
  runEndpointId: string;
  t: number;
  latencyP50: number | null;
  latencyP95: number | null;
  latencyMean: number | null;
  successRate: number | null;
  throughputRps: number | null;
  blockLag: number | null;
  spike: boolean;
}

export interface HistorySeries {
  endpointId: string;
  endpointName: string;
  provider: string;
  networkId: string;
  networkName: string;
  points: HistoryPoint[];
}

export interface Incident {
  type: 'latency_spike' | 'availability' | 'unreachable' | 'block_lag';
  endpointId: string;
  endpointName: string;
  runId: string;
  t: number;
  message: string;
}

export interface LeaderboardRow {
  endpointId: string;
  endpointName: string;
  provider: string;
  networkId: string;
  networkName: string;
  runs: number;
  /** Median of per-run P50 latency over the range. */
  latencyP50: number | null;
  /** Median of per-run P95 latency over the range. */
  latencyP95: number | null;
  /** Request-weighted success rate over the range. */
  successRate: number | null;
  /** Share of runs in which the endpoint met the availability threshold. */
  availability: number | null;
  avgBlockLag: number | null;
  lastSeen: number;
  rank: number;
}

export interface HistoryResponse {
  range: HistoryRange;
  from: number;
  to: number;
  series: HistorySeries[];
  leaderboard: LeaderboardRow[];
  incidents: Incident[];
}

export interface DashboardResponse {
  counts: { endpoints: number; enabledEndpoints: number; networks: number; runs: number; runsLast24h: number };
  leaderboard: LeaderboardRow[];
  recentRuns: RunSummary[];
  activeRun: RunSummary | null;
  incidents: Incident[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const settingsSchema = z.object({
  defaults: z.object({
    methods: z.array(methodIdSchema).min(1),
    requestsPerEndpoint: z.number().int().min(1).max(LIMITS.maxRequestsPerEndpoint).nullable(),
    durationSec: z.number().int().min(1).max(LIMITS.maxDurationSec).nullable(),
    concurrency: z.number().int().min(1).max(LIMITS.maxConcurrency),
    intervalMs: z.number().int().min(0).max(LIMITS.maxIntervalMs),
    timeoutMs: z.number().int().min(LIMITS.minTimeoutMs).max(LIMITS.maxTimeoutMs),
    warmup: z.boolean(),
  }),
  thresholds: z.object({
    /** Latency (ms) at or below which an endpoint is shown as healthy. */
    latencyGoodMs: z.number().int().min(1).max(60_000),
    /** Latency (ms) above which an endpoint is shown as degraded. */
    latencyWarnMs: z.number().int().min(1).max(60_000),
    /** Success rate (0–1) at or above which a run counts as "available". */
    availabilityMin: z.number().min(0).max(1),
    /** Blocks behind the network head before an endpoint is flagged. */
    blockLagBlocks: z.number().int().min(1).max(10_000),
    /** A run's P95 above this multiple of the endpoint's median P95 counts as a spike. */
    spikeFactor: z.number().min(1.1).max(100),
  }),
  retention: z.object({
    /** Delete raw request samples older than this many days (aggregates are kept). 0 keeps forever. */
    sampleDays: z.number().int().min(0).max(3650),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  defaults: {
    methods: ['eth_blockNumber', 'eth_chainId'],
    requestsPerEndpoint: 100,
    durationSec: 60,
    concurrency: 4,
    intervalMs: 0,
    timeoutMs: 10_000,
    warmup: true,
  },
  thresholds: {
    latencyGoodMs: 150,
    latencyWarnMs: 400,
    availabilityMin: 0.99,
    blockLagBlocks: 5,
    spikeFactor: 2,
  },
  retention: {
    sampleDays: 30,
  },
};

export interface SystemInfo {
  version: string;
  allowPrivateNetworks: boolean;
  secretKeySource: 'env' | 'file';
  limits: typeof LIMITS;
  methods: MethodInfo[];
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}
