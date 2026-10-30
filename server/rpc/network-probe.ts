import net from 'node:net';
import { resolveAllowed, validateRpcUrl } from './net-policy.js';

/**
 * Measures TCP handshake time to the endpoint host. A TCP connect completes in
 * one network round trip with no server-side application work, so its median is
 * a good approximation of pure network latency, independent of the RPC provider.
 */
export async function probeNetworkRtt(
  rawUrl: string,
  options: { allowPrivateNetworks: boolean; samples?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<number[]> {
  const { hostname, port } = validateRpcUrl(rawUrl, options.allowPrivateNetworks);
  const addresses = await resolveAllowed(hostname, options.allowPrivateNetworks);
  const target = addresses[0];
  if (!target) return [];
  const samples = options.samples ?? 5;
  const timeoutMs = options.timeoutMs ?? 3000;
  const results: number[] = [];
  for (let i = 0; i < samples && !options.signal?.aborted; i++) {
    const rtt = await connectOnce(target.address, port, timeoutMs);
    if (rtt !== null) results.push(rtt);
  }
  return results;
}

function connectOnce(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = net.connect({ host, port });
    const done = (value: number | null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once('connect', () => done(performance.now() - t0));
    socket.once('error', () => done(null));
  });
}
