import { eq, sql } from 'drizzle-orm';
import type { Network, NetworkCreateInput } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { endpoints, networks } from '../db/schema.js';
import { ConflictError } from './errors.js';

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'network'
  );
}

export function listNetworks(db: Db): Network[] {
  return db
    .select({
      id: networks.id,
      name: networks.name,
      slug: networks.slug,
      chainId: networks.chainId,
      isTestnet: networks.isTestnet,
      endpointCount: sql<number>`count(${endpoints.id})`,
    })
    .from(networks)
    .leftJoin(endpoints, eq(endpoints.networkId, networks.id))
    .groupBy(networks.id)
    .orderBy(networks.isTestnet, networks.name)
    .all();
}

export function getNetwork(db: Db, id: string) {
  return db.select().from(networks).where(eq(networks.id, id)).get() ?? null;
}

export function createNetwork(db: Db, input: NetworkCreateInput): Network {
  const slug = slugify(input.name);
  if (db.select({ id: networks.id }).from(networks).where(eq(networks.slug, slug)).get()) {
    throw new ConflictError(`A network named "${input.name}" already exists`);
  }
  const id = crypto.randomUUID();
  db.insert(networks).values({ id, slug, name: input.name, chainId: input.chainId, isTestnet: input.isTestnet }).run();
  return { id, slug, name: input.name, chainId: input.chainId, isTestnet: input.isTestnet, endpointCount: 0 };
}

export function deleteNetwork(db: Db, id: string): void {
  const inUse = db.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.networkId, id)).limit(1).get();
  if (inUse) throw new ConflictError('Network has endpoints; delete or move them first');
  db.delete(networks).where(eq(networks.id, id)).run();
}
