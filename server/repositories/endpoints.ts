import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Endpoint, EndpointCreateInput, EndpointLastRun, EndpointUpdateInput } from '../../shared/schemas.js';
import { endpointCreateSchema } from '../../shared/schemas.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/client.js';
import { endpoints, networks, runEndpoints } from '../db/schema.js';
import { UrlPolicyError, validateRpcUrlResolved } from '../rpc/net-policy.js';
import { redactUrl } from '../rpc/redact.js';
import { NotFoundError, ValidationError } from './errors.js';

export interface SecretContext {
  key: Buffer;
  allowPrivateNetworks: boolean;
}

const endpointColumns = {
  id: endpoints.id,
  name: endpoints.name,
  provider: endpoints.provider,
  description: endpoints.description,
  networkId: endpoints.networkId,
  networkName: networks.name,
  urlRedacted: endpoints.urlRedacted,
  host: endpoints.host,
  enabled: endpoints.enabled,
  createdAt: endpoints.createdAt,
  updatedAt: endpoints.updatedAt,
};

function lastRuns(db: Db, ids: string[]): Map<string, EndpointLastRun> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      endpointId: runEndpoints.endpointId,
      runId: runEndpoints.runId,
      finishedAt: runEndpoints.finishedAt,
      successRate: runEndpoints.successRate,
      latencyP50: runEndpoints.latencyP50,
    })
    .from(runEndpoints)
    .where(
      and(
        inArray(runEndpoints.endpointId, ids),
        sql`${runEndpoints.finishedAt} = (
          select max(re2.finished_at) from run_endpoints re2
          where re2.endpoint_id = ${runEndpoints.endpointId} and re2.status = 'completed'
        )`,
      ),
    )
    .all();
  const map = new Map<string, EndpointLastRun>();
  for (const r of rows) {
    if (r.endpointId && r.finishedAt !== null) {
      map.set(r.endpointId, { runId: r.runId, finishedAt: r.finishedAt, successRate: r.successRate, latencyP50: r.latencyP50 });
    }
  }
  return map;
}

export function listEndpoints(db: Db): Endpoint[] {
  const rows = db
    .select(endpointColumns)
    .from(endpoints)
    .innerJoin(networks, eq(networks.id, endpoints.networkId))
    .orderBy(networks.name, endpoints.provider, endpoints.name)
    .all();
  const runs = lastRuns(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lastRun: runs.get(r.id) ?? null }));
}

export function getEndpoint(db: Db, id: string): Endpoint {
  const row = db
    .select(endpointColumns)
    .from(endpoints)
    .innerJoin(networks, eq(networks.id, endpoints.networkId))
    .where(eq(endpoints.id, id))
    .get();
  if (!row) throw new NotFoundError('Endpoint not found');
  return { ...row, lastRun: lastRuns(db, [id]).get(id) ?? null };
}

/** Internal only: returns the decrypted URL for making requests. Never send to clients. */
export function getEndpointSecretUrl(db: Db, ctx: SecretContext, id: string): string {
  const row = db.select({ c: endpoints.urlCiphertext }).from(endpoints).where(eq(endpoints.id, id)).get();
  if (!row) throw new NotFoundError('Endpoint not found');
  return decryptSecret(row.c, ctx.key);
}

async function protectUrl(raw: string, ctx: SecretContext) {
  try {
    const { url, hostname } = await validateRpcUrlResolved(raw, ctx.allowPrivateNetworks);
    return { urlCiphertext: encryptSecret(url.href, ctx.key), urlRedacted: redactUrl(url.href), host: hostname };
  } catch (err) {
    if (err instanceof UrlPolicyError) throw new ValidationError(err.message);
    throw err;
  }
}

function assertNetwork(db: Db, networkId: string) {
  if (!db.select({ id: networks.id }).from(networks).where(eq(networks.id, networkId)).get()) {
    throw new ValidationError('Unknown network');
  }
}

export async function createEndpoint(db: Db, ctx: SecretContext, raw: EndpointCreateInput): Promise<Endpoint> {
  const input = endpointCreateSchema.parse(raw);
  assertNetwork(db, input.networkId);
  const protectedUrl = await protectUrl(input.url, ctx);
  const id = crypto.randomUUID();
  db.insert(endpoints)
    .values({
      id,
      networkId: input.networkId,
      name: input.name,
      provider: input.provider,
      description: input.description,
      enabled: input.enabled,
      ...protectedUrl,
    })
    .run();
  return getEndpoint(db, id);
}

export async function updateEndpoint(db: Db, ctx: SecretContext, id: string, input: EndpointUpdateInput): Promise<Endpoint> {
  getEndpoint(db, id);
  if (input.networkId) assertNetwork(db, input.networkId);
  const { url, ...rest } = input;
  const patch = { ...rest, ...(url ? await protectUrl(url, ctx) : {}), updatedAt: Date.now() };
  db.update(endpoints).set(patch).where(eq(endpoints.id, id)).run();
  return getEndpoint(db, id);
}

export function deleteEndpoint(db: Db, id: string): void {
  const res = db.delete(endpoints).where(eq(endpoints.id, id)).run();
  if (res.changes === 0) throw new NotFoundError('Endpoint not found');
}
