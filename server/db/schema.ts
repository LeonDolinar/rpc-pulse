import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  BenchmarkConfig,
  ErrorBreakdown,
  ErrorType,
  Issue,
  LatencyStats,
  MethodId,
  MethodStats,
  RunEndpointStatus,
  RunStatus,
  RunTrigger,
} from '../../shared/schemas.js';

const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

export const networks = sqliteTable('networks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  chainId: integer('chain_id'),
  isTestnet: integer('is_testnet', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().default(now),
});

export const endpoints = sqliteTable(
  'endpoints',
  {
    id: text('id').primaryKey(),
    networkId: text('network_id')
      .notNull()
      .references(() => networks.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    description: text('description').notNull().default(''),
    /** AES-256-GCM encrypted full URL (may contain API keys). */
    urlCiphertext: text('url_ciphertext').notNull(),
    /** Credential-masked URL safe for display. */
    urlRedacted: text('url_redacted').notNull(),
    host: text('host').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('endpoints_network_idx').on(t.networkId)],
);

/**
 * Reserved for scheduled/continuous monitoring: a schedule owns a benchmark
 * config and produces runs with trigger = 'scheduled'.
 */
export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).$type<BenchmarkConfig>().notNull(),
  intervalSec: integer('interval_sec').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: integer('last_run_at'),
  createdAt: integer('created_at').notNull().default(now),
});

export const benchmarkRuns = sqliteTable(
  'benchmark_runs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().default(''),
    status: text('status').$type<RunStatus>().notNull(),
    trigger: text('trigger').$type<RunTrigger>().notNull().default('manual'),
    scheduleId: text('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    /** Full config snapshot so a run can be reproduced exactly. */
    config: text('config', { mode: 'json' }).$type<BenchmarkConfig>().notNull(),
    createdAt: integer('created_at').notNull().default(now),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    error: text('error'),
  },
  (t) => [index('runs_created_idx').on(t.createdAt), index('runs_status_idx').on(t.status)],
);

/**
 * Per-endpoint results of a run. Endpoint identity is snapshotted so history
 * stays meaningful after an endpoint is renamed or deleted.
 */
export const runEndpoints = sqliteTable(
  'run_endpoints',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
    endpointId: text('endpoint_id').references(() => endpoints.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    endpointName: text('endpoint_name').notNull(),
    provider: text('provider').notNull(),
    networkId: text('network_id').notNull(),
    networkName: text('network_name').notNull(),
    expectedChainId: integer('expected_chain_id'),
    urlRedacted: text('url_redacted').notNull(),
    status: text('status').$type<RunEndpointStatus>().notNull().default('pending'),
    error: text('error'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    windowMs: real('window_ms'),
    total: integer('total').notNull().default(0),
    success: integer('success').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    successRate: real('success_rate'),
    throughputRps: real('throughput_rps'),
    successRps: real('success_rps'),
    // Key latency metrics are columns (not just JSON) so history queries can use them.
    latencyMean: real('latency_mean'),
    latencyP50: real('latency_p50'),
    latencyP95: real('latency_p95'),
    latencyP99: real('latency_p99'),
    latency: text('latency', { mode: 'json' }).$type<LatencyStats>(),
    ttfb: text('ttfb', { mode: 'json' }).$type<LatencyStats>(),
    networkRttMs: real('network_rtt_ms'),
    providerTimeMs: real('provider_time_ms'),
    errors: text('errors', { mode: 'json' }).$type<ErrorBreakdown>().notNull().default({}),
    observedChainId: integer('observed_chain_id'),
    clientVersion: text('client_version'),
    headBlock: integer('head_block'),
    blockLag: integer('block_lag'),
    issues: text('issues', { mode: 'json' }).$type<Issue[]>().notNull().default([]),
    methods: text('methods', { mode: 'json' }).$type<MethodStats[]>().notNull().default([]),
  },
  (t) => [
    index('run_endpoints_run_idx').on(t.runId),
    index('run_endpoints_endpoint_idx').on(t.endpointId, t.finishedAt),
  ],
);

/** Raw per-request measurements. Subject to retention; aggregates above are kept. */
export const requestSamples = sqliteTable(
  'request_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
    runEndpointId: text('run_endpoint_id')
      .notNull()
      .references(() => runEndpoints.id, { onDelete: 'cascade' }),
    method: text('method').$type<MethodId>().notNull(),
    startedAt: real('started_at').notNull(),
    ttfbMs: real('ttfb_ms'),
    totalMs: real('total_ms').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    errorType: text('error_type').$type<ErrorType>(),
    httpStatus: integer('http_status'),
    rpcErrorCode: integer('rpc_error_code'),
    errorMessage: text('error_message'),
    blockNumber: integer('block_number'),
  },
  (t) => [index('samples_run_endpoint_idx').on(t.runEndpointId, t.startedAt), index('samples_started_idx').on(t.startedAt)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});
