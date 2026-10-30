import type { MethodCategory, MethodId, MethodInfo } from '../../shared/schemas.js';

export type ValidationResult = { ok: true; value: unknown; blockNumber?: number } | { ok: false; message: string };

export interface BenchmarkMethod extends MethodInfo {
  rpcMethod: string;
  params(): unknown[];
  /** Validates that a successful JSON-RPC result has the expected shape. */
  validate(result: unknown): ValidationResult;
}

const HEX_QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;

function hexQuantity(result: unknown): ValidationResult {
  if (typeof result !== 'string' || !HEX_QUANTITY.test(result)) {
    return { ok: false, message: `Expected hex quantity, got ${preview(result)}` };
  }
  return { ok: true, value: result };
}

function preview(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

export function parseHexNumber(value: string): number {
  const n = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(n)) throw new Error('Hex value exceeds safe integer range');
  return n;
}

function define(
  id: MethodId,
  label: string,
  category: MethodCategory,
  description: string,
  params: () => unknown[],
  validate: (result: unknown) => ValidationResult,
): BenchmarkMethod {
  return { id, label, category, description, rpcMethod: id, params, validate };
}

/**
 * Registry of benchmark methods. Adding a method means adding an entry here
 * and its id to METHOD_IDS in shared/schemas.ts.
 */
export const METHODS: Record<MethodId, BenchmarkMethod> = {
  eth_chainId: define('eth_chainId', 'Chain ID', 'connectivity', 'Returns the chain ID. Cheap; served from node config.', () => [], hexQuantity),
  eth_blockNumber: define(
    'eth_blockNumber',
    'Block number',
    'connectivity',
    'Latest block height. Used for block-lag consistency checks.',
    () => [],
    (result) => {
      const v = hexQuantity(result);
      if (!v.ok) return v;
      try {
        return { ok: true, value: result, blockNumber: parseHexNumber(result as string) };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  ),
  net_version: define('net_version', 'Network version', 'connectivity', 'Network ID as a decimal string.', () => [], (result) =>
    typeof result === 'string' && /^\d+$/.test(result)
      ? { ok: true, value: result }
      : { ok: false, message: `Expected decimal string, got ${preview(result)}` },
  ),
  web3_clientVersion: define('web3_clientVersion', 'Client version', 'connectivity', 'Node client software and version.', () => [], (result) =>
    typeof result === 'string' && result.length > 0
      ? { ok: true, value: result }
      : { ok: false, message: `Expected non-empty string, got ${preview(result)}` },
  ),
  eth_gasPrice: define('eth_gasPrice', 'Gas price', 'performance', 'Current gas price. Requires node state access.', () => [], hexQuantity),
  eth_getBlockByNumber: define(
    'eth_getBlockByNumber',
    'Latest block (header)',
    'performance',
    'Fetches the latest block without transactions. Heavier payload than simple queries.',
    () => ['latest', false],
    (result) => {
      if (typeof result !== 'object' || result === null) return { ok: false, message: `Expected block object, got ${preview(result)}` };
      const block = result as Record<string, unknown>;
      if (typeof block.number !== 'string' || typeof block.hash !== 'string' || !HEX_QUANTITY.test(block.number)) {
        return { ok: false, message: 'Block object is missing number or hash' };
      }
      return { ok: true, value: block.number, blockNumber: parseHexNumber(block.number) };
    },
  ),
};

export function methodInfoList(): MethodInfo[] {
  return Object.values(METHODS).map(({ id, label, category, description }) => ({ id, label, category, description }));
}
