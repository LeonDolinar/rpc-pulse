import type { EndpointTestResult } from '../../shared/schemas.js';
import { JsonRpcHttpClient } from '../rpc/json-rpc-client.js';
import { UrlPolicyError } from '../rpc/net-policy.js';
import { sanitizeMessage } from '../rpc/redact.js';
import { METHODS } from './methods.js';

/** One-off connectivity check used by the endpoint form. Not a benchmark. */
export async function testEndpoint(
  url: string,
  expectedChainId: number | null,
  allowPrivateNetworks: boolean,
): Promise<EndpointTestResult> {
  const result: EndpointTestResult = {
    ok: false,
    chainId: null,
    expectedChainId,
    chainIdMatches: null,
    blockNumber: null,
    clientVersion: null,
    latencyMs: null,
    error: null,
  };
  let client: JsonRpcHttpClient;
  try {
    client = new JsonRpcHttpClient(url, { allowPrivateNetworks, connections: 1 });
  } catch (err) {
    result.error = err instanceof UrlPolicyError ? err.message : 'Invalid endpoint URL';
    return result;
  }
  try {
    const opts = { timeoutMs: 10_000 };
    const chain = await client.call('eth_chainId', [], opts);
    if (!chain.ok) {
      result.error = chain.error?.message ?? 'Request failed';
      return result;
    }
    if (!METHODS.eth_chainId.validate(chain.result).ok) {
      result.error = 'eth_chainId returned an unexpected value';
      return result;
    }
    result.chainId = Number.parseInt(chain.result as string, 16);
    result.chainIdMatches = expectedChainId === null ? null : result.chainId === expectedChainId;

    // Measure on the now-warm connection so the figure isn't dominated by TLS setup.
    const block = await client.call('eth_blockNumber', [], opts);
    result.latencyMs = Math.round(block.totalMs * 10) / 10;
    const v = block.ok ? METHODS.eth_blockNumber.validate(block.result) : null;
    if (v?.ok) result.blockNumber = v.blockNumber ?? null;

    const version = await client.call('web3_clientVersion', [], opts);
    if (version.ok && typeof version.result === 'string') result.clientVersion = version.result.slice(0, 200);

    result.ok = block.ok && result.chainIdMatches !== false;
    if (!block.ok) result.error = block.error?.message ?? 'eth_blockNumber failed';
    else if (result.chainIdMatches === false) result.error = `Chain ID ${result.chainId} does not match expected ${expectedChainId}`;
    return result;
  } catch (err) {
    result.error = sanitizeMessage((err as Error).message, url);
    return result;
  } finally {
    await client.close();
  }
}
