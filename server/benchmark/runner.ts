import type { FastifyBaseLogger } from 'fastify';
import type { BenchmarkConfig, RunProgress, RunTrigger } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { getEndpointSecretUrl, type SecretContext } from '../repositories/endpoints.js';
import { NotFoundError, ValidationError } from '../repositories/errors.js';
import {
  createRun,
  getRunRow,
  insertSamples,
  listRunEndpointRows,
  markRunEndpointStarted,
  nextQueuedRunId,
  saveEndpointAggregate,
  setRunStatus,
} from '../repositories/runs.js';
import { getSettings } from '../repositories/settings.js';
import { JsonRpcHttpClient } from '../rpc/json-rpc-client.js';
import { probeNetworkRtt } from '../rpc/network-probe.js';
import { runBenchmark, type BenchmarkTarget, type EndpointAggregate, type EngineDeps } from './engine.js';

interface ActiveRun {
  runId: string;
  controller: AbortController;
  startedAt: number;
  completed: number;
  expected: number | null;
  done: Promise<void>;
}

export interface RunnerOptions {
  db: Db;
  secrets: SecretContext;
  logger: FastifyBaseLogger;
  /** Override transports and probes (used by tests). */
  deps?: EngineDeps;
}

/**
 * Executes queued benchmark runs one at a time in the server process,
 * independent of any browser session. Runs are persisted before execution, so
 * the queue survives restarts; a run interrupted mid-flight is marked as such
 * on the next start. Running one benchmark at a time keeps runs from
 * competing for local bandwidth and skewing each other's latency.
 */
export class BenchmarkRunner {
  private active: ActiveRun | null = null;
  private stopped = false;
  private readonly deps: EngineDeps;

  constructor(private readonly opts: RunnerOptions) {
    this.deps = opts.deps ?? {
      createTransport: (target, connections) =>
        new JsonRpcHttpClient(target.url, { allowPrivateNetworks: opts.secrets.allowPrivateNetworks, connections }),
      probeRtt: (target, signal) =>
        probeNetworkRtt(target.url, { allowPrivateNetworks: opts.secrets.allowPrivateNetworks, signal }),
    };
  }

  enqueue(config: BenchmarkConfig, trigger: RunTrigger = 'manual'): string {
    const runId = createRun(this.opts.db, config, trigger);
    this.opts.logger.info({ runId, endpoints: config.endpointIds.length }, 'benchmark queued');
    queueMicrotask(() => this.kick());
    return runId;
  }

  /** Starts the next queued run if idle. */
  kick(): void {
    if (this.active || this.stopped) return;
    const runId = nextQueuedRunId(this.opts.db);
    if (!runId) return;
    const row = getRunRow(this.opts.db, runId)!;
    const controller = new AbortController();
    const active: ActiveRun = {
      runId,
      controller,
      startedAt: Date.now(),
      completed: 0,
      expected: row.config.requestsPerEndpoint !== null ? row.config.requestsPerEndpoint * row.config.endpointIds.length : null,
      done: Promise.resolve(),
    };
    this.active = active;
    active.done = this.execute(active, row.config)
      .catch((err: unknown) => {
        this.opts.logger.error({ runId, err: (err as Error).message }, 'benchmark failed');
        setRunStatus(this.opts.db, runId, 'failed', { finishedAt: Date.now(), error: 'Internal error while running benchmark' });
      })
      .finally(() => {
        this.active = null;
        this.kick();
      });
  }

  progress(runId: string): RunProgress | null {
    if (this.active?.runId !== runId) return null;
    return { completed: this.active.completed, expected: this.active.expected, elapsedMs: Date.now() - this.active.startedAt };
  }

  cancel(runId: string): void {
    const row = getRunRow(this.opts.db, runId);
    if (!row) throw new NotFoundError('Run not found');
    if (this.active?.runId === runId) {
      this.active.controller.abort();
      return;
    }
    if (row.status !== 'queued') throw new ValidationError(`Run is ${row.status}`);
    setRunStatus(this.opts.db, runId, 'cancelled', { finishedAt: Date.now() });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.active) {
      this.active.controller.abort();
      await this.active.done;
    }
  }

  /** Resolves when the given run is no longer active (test helper). */
  async waitFor(runId: string): Promise<void> {
    while (this.active?.runId === runId || getRunRow(this.opts.db, runId)?.status === 'queued') {
      if (this.active) await this.active.done;
      else await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async execute(active: ActiveRun, config: BenchmarkConfig): Promise<void> {
    const { db, logger, secrets } = this.opts;
    const { runId, controller } = active;
    setRunStatus(db, runId, 'running', { startedAt: active.startedAt });
    logger.info({ runId }, 'benchmark started');

    const settings = getSettings(db);
    const targets: BenchmarkTarget[] = [];
    const unavailable: EndpointAggregate[] = [];
    for (const row of listRunEndpointRows(db, runId)) {
      let url: string | null = null;
      try {
        url = row.endpointId ? getEndpointSecretUrl(db, secrets, row.endpointId) : null;
      } catch {
        url = null;
      }
      if (url) {
        targets.push({ runEndpointId: row.id, networkId: row.networkId, expectedChainId: row.expectedChainId, url });
      } else {
        unavailable.push(emptyAggregate(row.id, 'Endpoint was deleted or its URL could not be decrypted'));
      }
    }

    const results = await runBenchmark(
      config,
      targets,
      this.deps,
      {
        onEndpointStart: (id, startedAt) => markRunEndpointStarted(db, id, startedAt),
        onSamples: (samples) => insertSamples(db, runId, samples),
        onProgress: (completed) => {
          active.completed = completed;
        },
      },
      { blockLagBlocks: settings.thresholds.blockLagBlocks, availabilityMin: settings.thresholds.availabilityMin },
      controller.signal,
    );

    db.transaction(() => {
      for (const r of [...results, ...unavailable]) saveEndpointAggregate(db, r);
      setRunStatus(db, runId, controller.signal.aborted ? 'cancelled' : 'completed', { finishedAt: Date.now() });
    });
    logger.info({ runId, status: controller.signal.aborted ? 'cancelled' : 'completed', requests: active.completed }, 'benchmark finished');
  }
}

function emptyAggregate(runEndpointId: string, error: string): EndpointAggregate {
  return {
    runEndpointId,
    status: 'failed',
    error,
    startedAt: null,
    finishedAt: Date.now(),
    windowMs: null,
    total: 0,
    success: 0,
    failed: 0,
    successRate: null,
    throughputRps: null,
    successRps: null,
    latency: null,
    ttfb: null,
    networkRttMs: null,
    providerTimeMs: null,
    errors: {},
    observedChainId: null,
    clientVersion: null,
    headBlock: null,
    blockLag: null,
    issues: [{ code: 'unreachable', severity: 'critical', message: error }],
    methods: [],
  };
}
