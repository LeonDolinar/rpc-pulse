import { Agent, request } from 'undici';
import type { ErrorType } from '../../shared/schemas.js';
import { createGuardedLookup, validateRpcUrl } from './net-policy.js';
import { sanitizeMessage } from './redact.js';

/** Maximum response body accepted from an endpoint. Protects memory from hostile responses. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'rpc-pulse/0.1 (+benchmark)';

export interface RpcError {
  type: ErrorType;
  message: string;
  httpStatus?: number;
  rpcCode?: number;
  /** Server-requested backoff (from Retry-After) in milliseconds. */
  retryAfterMs?: number;
}

export interface RpcCallOutcome {
  /** Unix epoch milliseconds (fractional) when the request was sent. */
  startedAt: number;
  /** Time until response headers arrived. Null when no response was received. */
  ttfbMs: number | null;
  /** Time until the body was fully read and parsed, or the request failed. */
  totalMs: number;
  ok: boolean;
  result?: unknown;
  error?: RpcError;
}

export interface RpcCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Protocol-agnostic transport interface; the benchmark engine depends only on this. */
export interface RpcTransport {
  call(method: string, params: unknown[], options: RpcCallOptions): Promise<RpcCallOutcome>;
  close(): Promise<void>;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export interface JsonRpcClientOptions {
  allowPrivateNetworks: boolean;
  /** Max sockets to the endpoint origin. Should be >= benchmark concurrency. */
  connections?: number;
}

const RATE_LIMIT_RPC_CODES = new Set([-32005, -32029, 429]);
const RATE_LIMIT_MESSAGE = /rate.?limit|too many requests|request limit|exceeded.*(limit|quota|capacity)|capacity exceeded|throttl/i;

function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function readCapped(body: AsyncIterable<Buffer> & { destroy(err?: Error): unknown }): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      body.destroy();
      throw Object.assign(new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`), { code: 'ERESPONSETOOLARGE' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']);

/**
 * EVM JSON-RPC over HTTP(S). One client per endpoint, each with its own
 * connection pool, so a slow or failing endpoint cannot starve the others.
 */
export class JsonRpcHttpClient implements RpcTransport {
  private readonly agent: Agent;
  private readonly url: string;
  private nextId = 1;

  constructor(url: string, options: JsonRpcClientOptions) {
    // Structural check (scheme, literal IPs). DNS-resolved addresses are checked per connection.
    validateRpcUrl(url, options.allowPrivateNetworks);
    this.url = url;
    this.agent = new Agent({
      connections: options.connections ?? 16,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      connect: {
        timeout: 10_000,
        lookup: createGuardedLookup(options.allowPrivateNetworks),
      },
    });
  }

  async call(method: string, params: unknown[], options: RpcCallOptions): Promise<RpcCallOutcome> {
    if (options.signal?.aborted) throw new CancelledError();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const t0 = performance.now();
    const startedAt = performance.timeOrigin + t0;
    let ttfbMs: number | null = null;
    const fail = (error: RpcError): RpcCallOutcome => ({
      startedAt,
      ttfbMs,
      totalMs: performance.now() - t0,
      ok: false,
      error: { ...error, message: sanitizeMessage(error.message, this.url) },
    });

    try {
      const res = await request(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
        body: payload,
        dispatcher: this.agent,
        signal: controller.signal,
      });
      ttfbMs = performance.now() - t0;
      const text = await readCapped(res.body);
      const status = res.statusCode;

      if (status === 429) {
        return fail({
          type: 'rate_limited',
          message: 'HTTP 429 Too Many Requests',
          httpStatus: status,
          retryAfterMs: parseRetryAfter(res.headers['retry-after']),
        });
      }
      if (status >= 300 && status < 400) {
        return fail({ type: 'http', message: `HTTP ${status} redirect (redirects are not followed)`, httpStatus: status });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (status >= 400) return fail({ type: 'http', message: `HTTP ${status}`, httpStatus: status });
        return fail({ type: 'invalid_response', message: 'Response body is not valid JSON', httpStatus: status });
      }
      const outcome = this.interpret(parsed, id, status);
      if (outcome.ok) {
        return { startedAt, ttfbMs, totalMs: performance.now() - t0, ok: true, result: outcome.result };
      }
      return fail(outcome.error);
    } catch (err) {
      if (options.signal?.aborted && !timedOut) throw new CancelledError();
      const e = err as NodeJS.ErrnoException;
      if (timedOut || (e.code && TIMEOUT_CODES.has(e.code))) {
        return fail({ type: 'timeout', message: `Timed out after ${options.timeoutMs} ms` });
      }
      if (e.code === 'ERESPONSETOOLARGE') return fail({ type: 'invalid_response', message: e.message });
      const cause = (e as { cause?: NodeJS.ErrnoException }).cause;
      const code = e.code ?? cause?.code;
      const detail = cause?.message ?? e.message ?? 'Request failed';
      return fail({ type: 'network', message: code ? `${code}: ${detail}` : detail });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private interpret(
    parsed: unknown,
    id: number,
    status: number,
  ): { ok: true; result: unknown } | { ok: false; error: RpcError } {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: { type: 'invalid_response', message: 'Response is not a JSON-RPC object', httpStatus: status } };
    }
    const body = parsed as Record<string, unknown>;
    if (body.error !== undefined && body.error !== null) {
      const err = body.error as { code?: unknown; message?: unknown };
      const code = typeof err.code === 'number' ? err.code : undefined;
      const message = typeof err.message === 'string' ? err.message : JSON.stringify(body.error).slice(0, 200);
      const rateLimited = status === 429 || (code !== undefined && RATE_LIMIT_RPC_CODES.has(code)) || RATE_LIMIT_MESSAGE.test(message);
      return {
        ok: false,
        error: {
          type: rateLimited ? 'rate_limited' : 'rpc_error',
          message: code !== undefined ? `${code}: ${message}` : message,
          httpStatus: status,
          rpcCode: code,
        },
      };
    }
    if (status >= 400) {
      return { ok: false, error: { type: 'http', message: `HTTP ${status}`, httpStatus: status } };
    }
    if (!('result' in body)) {
      return { ok: false, error: { type: 'invalid_response', message: 'JSON-RPC response has neither result nor error', httpStatus: status } };
    }
    if (body.id !== id) {
      return { ok: false, error: { type: 'invalid_response', message: 'JSON-RPC response id does not match request', httpStatus: status } };
    }
    return { ok: true, result: body.result };
  }

  async close(): Promise<void> {
    await this.agent.close().catch(() => this.agent.destroy());
  }
}
