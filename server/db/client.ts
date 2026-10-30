import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

export function openDatabase(file: string): DbHandle {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, sqlite };
}

const SEED_NETWORKS = [
  { name: 'Ethereum Mainnet', slug: 'ethereum', chainId: 1, isTestnet: false },
  { name: 'Ethereum Sepolia', slug: 'sepolia', chainId: 11155111, isTestnet: true },
  { name: 'Ethereum Hoodi', slug: 'hoodi', chainId: 560048, isTestnet: true },
  { name: 'Base', slug: 'base', chainId: 8453, isTestnet: false },
  { name: 'Arbitrum One', slug: 'arbitrum', chainId: 42161, isTestnet: false },
  { name: 'OP Mainnet', slug: 'optimism', chainId: 10, isTestnet: false },
  { name: 'Polygon PoS', slug: 'polygon', chainId: 137, isTestnet: false },
  { name: 'BNB Smart Chain', slug: 'bsc', chainId: 56, isTestnet: false },
  { name: 'Avalanche C-Chain', slug: 'avalanche', chainId: 43114, isTestnet: false },
];

/** Inserts well-known EVM networks on first start. */
export function seedNetworks(db: Db): void {
  const existing = db.select({ id: schema.networks.id }).from(schema.networks).limit(1).all();
  if (existing.length > 0) return;
  db.insert(schema.networks)
    .values(SEED_NETWORKS.map((n) => ({ ...n, id: crypto.randomUUID() })))
    .run();
}
