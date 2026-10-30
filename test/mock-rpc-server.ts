import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockBehavior {
  chainId?: number;
  blockNumber?: () => number;
  latencyMs?: number;
  /** Fraction of requests answered with a JSON-RPC internal error. */
  errorRate?: number;
  /** Respond 429 to every Nth request. */
  rateLimitEvery?: number;
  /** Return non-JSON bodies. */
  malformed?: boolean;
  /** Never respond (to exercise timeouts). */
  hang?: boolean;
  /** Respond with a redirect. */
  redirect?: boolean;
}

export interface MockServer {
  url: string;
  requests: number;
  behavior: MockBehavior;
  close(): Promise<void>;
}

export async function startMockRpc(behavior: MockBehavior = {}): Promise<MockServer> {
  let counter = 0;
  const state: MockServer = { url: '', requests: 0, behavior, close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      counter++;
      state.requests = counter;
      const b = state.behavior;
      if (b.hang) return;
      const respond = () => {
        if (b.redirect) {
          res.writeHead(302, { location: 'http://example.com/' }).end();
          return;
        }
        if (b.rateLimitEvery && counter % b.rateLimitEvery === 0) {
          res.writeHead(429, { 'retry-after': '0' }).end('slow down');
          return;
        }
        if (b.malformed) {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<html>bad gateway</html>');
          return;
        }
        const msg = JSON.parse(body) as { id: number; method: string };
        if (b.errorRate && Math.random() < b.errorRate) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } }));
          return;
        }
        const chainId = b.chainId ?? 1;
        const results: Record<string, unknown> = {
          eth_chainId: '0x' + chainId.toString(16),
          eth_blockNumber: '0x' + (b.blockNumber?.() ?? 1000).toString(16),
          net_version: String(chainId),
          web3_clientVersion: 'MockClient/v1.0.0',
          eth_gasPrice: '0x3b9aca00',
          eth_getBlockByNumber: { number: '0x' + (b.blockNumber?.() ?? 1000).toString(16), hash: '0x' + 'ab'.repeat(32) },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        if (msg.method in results) {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: results[msg.method] }));
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
        }
      };
      if (b.latencyMs) setTimeout(respond, b.latencyMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/v2/secretkey1234567890abcdef`;
  state.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
