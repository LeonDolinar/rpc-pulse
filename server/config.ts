import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  allowPrivateNetworks: boolean;
  secretKey: Buffer;
  secretKeySource: 'env' | 'file';
  webDistPath: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('RPC_PULSE_SECRET_KEY must decode to exactly 32 bytes (base64 or hex)');
  }
  return key;
}

/**
 * Resolve the encryption key. Prefers the environment; otherwise falls back to a
 * key file next to the database so local development works without setup.
 */
function resolveSecretKey(databasePath: string): { key: Buffer; source: 'env' | 'file' } {
  const fromEnv = process.env.RPC_PULSE_SECRET_KEY;
  if (fromEnv) return { key: decodeKey(fromEnv), source: 'env' };

  const keyPath = path.join(path.dirname(databasePath), '.secret-key');
  if (fs.existsSync(keyPath)) {
    return { key: decodeKey(fs.readFileSync(keyPath, 'utf8')), source: 'file' };
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  return { key, source: 'file' };
}

export function loadConfig(): AppConfig {
  const databasePath = path.resolve(process.env.DATABASE_PATH ?? './data/rpc-pulse.db');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { key, source } = resolveSecretKey(databasePath);
  const port = Number(process.env.PORT ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${process.env.PORT}`);
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port,
    databasePath,
    allowPrivateNetworks: parseBool(process.env.ALLOW_PRIVATE_NETWORKS, false),
    secretKey: key,
    secretKeySource: source,
    webDistPath: path.resolve(process.env.WEB_DIST_PATH ?? './dist/web'),
  };
}
