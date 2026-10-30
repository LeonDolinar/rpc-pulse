import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HISTORY_RANGES,
  LIMITS,
  benchmarkConfigSchema,
  endpointCreateSchema,
  endpointUpdateSchema,
  networkCreateSchema,
  settingsSchema,
  type SystemInfo,
} from '../../shared/schemas.js';
import { testEndpoint } from '../benchmark/endpoint-test.js';
import { methodInfoList } from '../benchmark/methods.js';
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  getEndpointSecretUrl,
  listEndpoints,
  updateEndpoint,
} from '../repositories/endpoints.js';
import { ValidationError } from '../repositories/errors.js';
import { getDashboard, getHistory } from '../repositories/history.js';
import { createNetwork, deleteNetwork, getNetwork, listNetworks } from '../repositories/networks.js';
import { deleteRun, getRunDetail, getRunRow, getSamples, listRuns } from '../repositories/runs.js';
import { getSettings, saveSettings } from '../repositories/settings.js';
import { NotFoundError } from '../repositories/errors.js';

const idParams = z.object({ id: z.string().min(1).max(64) });

export async function registerRoutes(app: FastifyInstance) {
  const { db, config, runner } = app.ctx;
  const secrets = { key: config.secretKey, allowPrivateNetworks: config.allowPrivateNetworks };

  app.get('/health', async () => ({ ok: true }));

  app.get('/system', async (): Promise<SystemInfo> => ({
    version: '0.1.0',
    allowPrivateNetworks: config.allowPrivateNetworks,
    secretKeySource: config.secretKeySource,
    limits: LIMITS,
    methods: methodInfoList(),
  }));

  // --- Networks -------------------------------------------------------------
  app.get('/networks', async () => listNetworks(db));
  app.post('/networks', async (req, reply) => reply.status(201).send(createNetwork(db, networkCreateSchema.parse(req.body))));
  app.delete('/networks/:id', async (req, reply) => {
    deleteNetwork(db, idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  // --- Endpoints ------------------------------------------------------------
  app.get('/endpoints', async () => listEndpoints(db));
  app.get('/endpoints/:id', async (req) => getEndpoint(db, idParams.parse(req.params).id));
  app.post('/endpoints', async (req, reply) => reply.status(201).send(await createEndpoint(db, secrets, endpointCreateSchema.parse(req.body))));
  app.patch('/endpoints/:id', async (req) => updateEndpoint(db, secrets, idParams.parse(req.params).id, endpointUpdateSchema.parse(req.body)));
  app.delete('/endpoints/:id', async (req, reply) => {
    deleteEndpoint(db, idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  /** Connectivity check for a saved endpoint. */
  app.post('/endpoints/:id/test', async (req) => {
    const endpoint = getEndpoint(db, idParams.parse(req.params).id);
    const network = getNetwork(db, endpoint.networkId);
    return testEndpoint(getEndpointSecretUrl(db, secrets, endpoint.id), network?.chainId ?? null, config.allowPrivateNetworks);
  });

  /** Connectivity check for a URL that hasn't been saved yet (endpoint form). */
  app.post('/endpoints/test', async (req) => {
    const body = z.object({ url: z.string().trim().min(1).max(2048), networkId: z.string().min(1) }).parse(req.body);
    const network = getNetwork(db, body.networkId);
    if (!network) throw new ValidationError('Unknown network');
    return testEndpoint(body.url, network.chainId, config.allowPrivateNetworks);
  });

  // --- Benchmark runs -------------------------------------------------------
  app.get('/methods', async () => methodInfoList());

  app.get('/runs', async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
      })
      .parse(req.query);
    return listRuns(db, q);
  });

  app.post('/runs', async (req, reply) => {
    const config = benchmarkConfigSchema.parse(req.body);
    const runId = runner.enqueue(config);
    return reply.status(201).send(getRunDetail(db, runId, null));
  });

  app.get('/runs/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return getRunDetail(db, id, runner.progress(id));
  });

  app.get('/runs/:id/samples', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({ runEndpointId: z.string().optional(), limit: z.coerce.number().int().min(1).max(20_000).default(5_000) })
      .parse(req.query);
    if (!getRunRow(db, id)) throw new NotFoundError('Run not found');
    return getSamples(db, id, q);
  });

  app.post('/runs/:id/cancel', async (req) => {
    const { id } = idParams.parse(req.params);
    runner.cancel(id);
    return { ok: true };
  });

  /** Re-runs a benchmark with an identical configuration. */
  app.post('/runs/:id/rerun', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const row = getRunRow(db, id);
    if (!row) throw new NotFoundError('Run not found');
    const runId = runner.enqueue(benchmarkConfigSchema.parse(row.config));
    return reply.status(201).send(getRunDetail(db, runId, null));
  });

  app.delete('/runs/:id', async (req, reply) => {
    deleteRun(db, idParams.parse(req.params).id);
    return reply.status(204).send();
  });

  // --- History & dashboard ----------------------------------------------------
  app.get('/history', async (req) => {
    const q = z
      .object({
        range: z.enum(HISTORY_RANGES).default('7d'),
        networkId: z.string().optional(),
        endpointIds: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
      })
      .parse(req.query);
    return getHistory(db, getSettings(db).thresholds, q.range, { networkId: q.networkId, endpointIds: q.endpointIds });
  });

  app.get('/dashboard', async () => getDashboard(db, getSettings(db).thresholds));

  // --- Settings ---------------------------------------------------------------
  app.get('/settings', async () => getSettings(db));
  app.put('/settings', async (req) => {
    const value = settingsSchema.parse(req.body);
    if (value.thresholds.latencyWarnMs < value.thresholds.latencyGoodMs) {
      throw new ValidationError('Degraded latency threshold must be at least the healthy threshold');
    }
    return saveSettings(db, value);
  });
}
