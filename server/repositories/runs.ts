import { and, asc, count, desc, eq, inArray, lt } from 'drizzle-orm';
import type {
  BenchmarkConfig,
  Paginated,
  RunDetail,
  RunEndpointResult,
  RunProgress,
  RunStatus,
  RunSummary,
  RunTrigger,
  Sample,
} from '../../shared/schemas.js';
import type { EndpointAggregate } from '../benchmark/engine.js';
import type { Db } from '../db/client.js';
import { benchmarkRuns, endpoints, networks, requestSamples, runEndpoints } from '../db/schema.js';
import { NotFoundError, ValidationError } from './errors.js';

type RunRow = typeof benchmarkRuns.$inferSelect;
type RunEndpointRow = typeof runEndpoints.$inferSelect;

const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running'];

/** Creates a queued run with a snapshot of each selected endpoint. */
export function createRun(db: Db, config: BenchmarkConfig, trigger: RunTrigger = 'manual', scheduleId: string | null = null): string {
  const rows = db
    .select({
      id: endpoints.id,
      name: endpoints.name,
      provider: endpoints.provider,
      enabled: endpoints.enabled,
      urlRedacted: endpoints.urlRedacted,
      networkId: networks.id,
      networkName: networks.name,
      chainId: networks.chainId,
    })
    .from(endpoints)
    .innerJoin(networks, eq(networks.id, endpoints.networkId))
    .where(inArray(endpoints.id, config.endpointIds))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = config.endpointIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new ValidationError(`Unknown endpoint(s): ${missing.join(', ')}`);
  const disabled = rows.filter((r) => !r.enabled);
  if (disabled.length > 0) throw new ValidationError(`Disabled endpoint(s): ${disabled.map((r) => r.name).join(', ')}`);

  const runId = crypto.randomUUID();
  db.transaction((tx) => {
    tx.insert(benchmarkRuns).values({ id: runId, name: config.name, status: 'queued', trigger, scheduleId, config }).run();
    tx.insert(runEndpoints)
      .values(
        config.endpointIds.map((endpointId, position) => {
          const e = byId.get(endpointId)!;
          return {
            id: crypto.randomUUID(),
            runId,
            endpointId,
            position,
            endpointName: e.name,
            provider: e.provider,
            networkId: e.networkId,
            networkName: e.networkName,
            expectedChainId: e.chainId,
            urlRedacted: e.urlRedacted,
          };
        }),
      )
      .run();
  });
  return runId;
}

function toResult(row: RunEndpointRow): RunEndpointResult {
  return {
    id: row.id,
    endpointId: row.endpointId,
    endpointName: row.endpointName,
    provider: row.provider,
    networkId: row.networkId,
    networkName: row.networkName,
    expectedChainId: row.expectedChainId,
    urlRedacted: row.urlRedacted,
    status: row.status,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    windowMs: row.windowMs,
    total: row.total,
    success: row.success,
    failed: row.failed,
    successRate: row.successRate,
    throughputRps: row.throughputRps,
    successRps: row.successRps,
    latency: row.latency ?? null,
    ttfb: row.ttfb ?? null,
    networkRttMs: row.networkRttMs,
    providerTimeMs: row.providerTimeMs,
    errors: row.errors,
    observedChainId: row.observedChainId,
    clientVersion: row.clientVersion,
    headBlock: row.headBlock,
    blockLag: row.blockLag,
    issues: row.issues,
    methods: row.methods,
  };
}

function toSummary(run: RunRow, eps: RunEndpointRow[]): RunSummary {
  const total = eps.reduce((acc, e) => acc + e.total, 0);
  const success = eps.reduce((acc, e) => acc + e.success, 0);
  // "Best" requires a usable success rate so a fast-failing endpoint can't win.
  const best = eps
    .filter((e) => e.latencyP50 !== null && (e.successRate ?? 0) >= 0.9)
    .sort((a, b) => a.latencyP50! - b.latencyP50!)[0];
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    trigger: run.trigger,
    config: run.config,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    endpointCount: eps.length,
    networks: [...new Set(eps.map((e) => e.networkName))],
    totalRequests: total,
    successRate: total > 0 ? success / total : null,
    bestEndpoint: best ? { name: best.endpointName, provider: best.provider, latencyP50: best.latencyP50! } : null,
  };
}

function endpointsForRuns(db: Db, runIds: string[]): Map<string, RunEndpointRow[]> {
  const map = new Map<string, RunEndpointRow[]>();
  if (runIds.length === 0) return map;
  const rows = db.select().from(runEndpoints).where(inArray(runEndpoints.runId, runIds)).orderBy(asc(runEndpoints.position)).all();
  for (const row of rows) {
    const list = map.get(row.runId) ?? [];
    list.push(row);
    map.set(row.runId, list);
  }
  return map;
}

export function listRuns(db: Db, opts: { limit: number; offset: number; status?: RunStatus }): Paginated<RunSummary> {
  const where = opts.status ? eq(benchmarkRuns.status, opts.status) : undefined;
  const runs = db.select().from(benchmarkRuns).where(where).orderBy(desc(benchmarkRuns.createdAt)).limit(opts.limit).offset(opts.offset).all();
  const total = db.select({ n: count() }).from(benchmarkRuns).where(where).get()?.n ?? 0;
  const eps = endpointsForRuns(db, runs.map((r) => r.id));
  return { items: runs.map((r) => toSummary(r, eps.get(r.id) ?? [])), total };
}

export function getRunSummary(db: Db, id: string): RunSummary {
  const run = db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, id)).get();
  if (!run) throw new NotFoundError('Run not found');
  return toSummary(run, endpointsForRuns(db, [id]).get(id) ?? []);
}

export function getRunDetail(db: Db, id: string, progress: RunProgress | null): RunDetail {
  const run = db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, id)).get();
  if (!run) throw new NotFoundError('Run not found');
  const eps = endpointsForRuns(db, [id]).get(id) ?? [];
  return { ...toSummary(run, eps), endpoints: eps.map(toResult), progress };
}

export function getActiveRun(db: Db): RunSummary | null {
  const run = db
    .select()
    .from(benchmarkRuns)
    .where(inArray(benchmarkRuns.status, ACTIVE_STATUSES))
    .orderBy(asc(benchmarkRuns.createdAt))
    .limit(1)
    .get();
  return run ? toSummary(run, endpointsForRuns(db, [run.id]).get(run.id) ?? []) : null;
}

export function getRunRow(db: Db, id: string): RunRow | null {
  return db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, id)).get() ?? null;
}

export function listRunEndpointRows(db: Db, runId: string): RunEndpointRow[] {
  return db.select().from(runEndpoints).where(eq(runEndpoints.runId, runId)).orderBy(asc(runEndpoints.position)).all();
}

export function nextQueuedRunId(db: Db): string | null {
  return (
    db
      .select({ id: benchmarkRuns.id })
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.status, 'queued'))
      .orderBy(asc(benchmarkRuns.createdAt))
      .limit(1)
      .get()?.id ?? null
  );
}

export function setRunStatus(db: Db, id: string, status: RunStatus, patch: { startedAt?: number; finishedAt?: number; error?: string | null } = {}) {
  db.update(benchmarkRuns).set({ status, ...patch }).where(eq(benchmarkRuns.id, id)).run();
}

export function markRunEndpointStarted(db: Db, runEndpointId: string, startedAt: number) {
  db.update(runEndpoints).set({ status: 'running', startedAt }).where(eq(runEndpoints.id, runEndpointId)).run();
}

export function saveEndpointAggregate(db: Db, a: EndpointAggregate) {
  db.update(runEndpoints)
    .set({
      status: a.status,
      error: a.error,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      windowMs: a.windowMs,
      total: a.total,
      success: a.success,
      failed: a.failed,
      successRate: a.successRate,
      throughputRps: a.throughputRps,
      successRps: a.successRps,
      latencyMean: a.latency?.mean ?? null,
      latencyP50: a.latency?.p50 ?? null,
      latencyP95: a.latency?.p95 ?? null,
      latencyP99: a.latency?.p99 ?? null,
      latency: a.latency,
      ttfb: a.ttfb,
      networkRttMs: a.networkRttMs,
      providerTimeMs: a.providerTimeMs,
      errors: a.errors,
      observedChainId: a.observedChainId,
      clientVersion: a.clientVersion,
      headBlock: a.headBlock,
      blockLag: a.blockLag,
      issues: a.issues,
      methods: a.methods,
    })
    .where(eq(runEndpoints.id, a.runEndpointId))
    .run();
}

export function insertSamples(db: Db, runId: string, samples: Sample[]) {
  if (samples.length === 0) return;
  db.transaction((tx) => {
    // Chunked to stay under SQLite's bound-parameter limit.
    for (let i = 0; i < samples.length; i += 500) {
      tx.insert(requestSamples)
        .values(samples.slice(i, i + 500).map((s) => ({ ...s, runId })))
        .run();
    }
  });
}

export function getSamples(db: Db, runId: string, opts: { runEndpointId?: string; limit: number }): Sample[] {
  const where = opts.runEndpointId
    ? and(eq(requestSamples.runId, runId), eq(requestSamples.runEndpointId, opts.runEndpointId))
    : eq(requestSamples.runId, runId);
  return db
    .select({
      runEndpointId: requestSamples.runEndpointId,
      method: requestSamples.method,
      startedAt: requestSamples.startedAt,
      ttfbMs: requestSamples.ttfbMs,
      totalMs: requestSamples.totalMs,
      ok: requestSamples.ok,
      errorType: requestSamples.errorType,
      httpStatus: requestSamples.httpStatus,
      rpcErrorCode: requestSamples.rpcErrorCode,
      errorMessage: requestSamples.errorMessage,
      blockNumber: requestSamples.blockNumber,
    })
    .from(requestSamples)
    .where(where)
    .orderBy(asc(requestSamples.startedAt))
    .limit(opts.limit)
    .all();
}

/** Runs left active by a previous process can't resume: mark them interrupted. */
export function markOrphanedRunsInterrupted(db: Db): number {
  const now = Date.now();
  const orphaned = db.select({ id: benchmarkRuns.id }).from(benchmarkRuns).where(eq(benchmarkRuns.status, 'running')).all();
  for (const { id } of orphaned) {
    db.transaction((tx) => {
      tx.update(benchmarkRuns)
        .set({ status: 'interrupted', finishedAt: now, error: 'Server stopped while the run was in progress' })
        .where(eq(benchmarkRuns.id, id))
        .run();
      tx.update(runEndpoints)
        .set({ status: 'failed', error: 'Interrupted', finishedAt: now })
        .where(and(eq(runEndpoints.runId, id), inArray(runEndpoints.status, ['pending', 'running'])))
        .run();
    });
  }
  return orphaned.length;
}

export function deleteRun(db: Db, id: string) {
  const run = getRunRow(db, id);
  if (!run) throw new NotFoundError('Run not found');
  if (ACTIVE_STATUSES.includes(run.status)) throw new ValidationError('Cancel the run before deleting it');
  db.delete(benchmarkRuns).where(eq(benchmarkRuns.id, id)).run();
}

export function purgeSamplesOlderThan(db: Db, cutoff: number): number {
  return db.delete(requestSamples).where(lt(requestSamples.startedAt, cutoff)).run().changes;
}
