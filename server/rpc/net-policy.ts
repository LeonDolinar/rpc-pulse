import dns from 'node:dns';
import net from 'node:net';

/**
 * Outbound request policy. RPC Pulse makes requests to user-supplied URLs, so it
 * must not become a proxy into private networks (SSRF). Addresses are checked
 * both when a URL is saved and on every connection (via a guarded DNS lookup),
 * which also defeats DNS-rebinding between the check and the request.
 */

export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

const blocked = new net.BlockList();
// IPv4 special-purpose ranges (RFC 6890 and friends).
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
// IPv6 special-purpose ranges.
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** Extracts an embedded IPv4 address from IPv4-mapped / NAT64 / 6to4-style IPv6 addresses. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // Not an IP: refuse rather than guess.
}

const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

export interface ParsedRpcUrl {
  url: URL;
  hostname: string;
  port: number;
}

/** Synchronous structural validation of an RPC URL. Throws UrlPolicyError. */
export function validateRpcUrl(raw: string, allowPrivate: boolean): ParsedRpcUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlPolicyError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError('Only http:// and https:// endpoints are supported');
  }
  if (url.hash) throw new UrlPolicyError('URL must not contain a fragment');
  // WHATWG URL keeps brackets around IPv6 literals in `hostname`.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new UrlPolicyError('URL must include a host');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  if (!allowPrivate) {
    if (net.isIP(hostname) && isBlockedAddress(hostname)) {
      throw new UrlPolicyError('Private, loopback and reserved addresses are not allowed');
    }
    if (hostname === 'localhost' || LOCAL_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
      throw new UrlPolicyError('Local hostnames are not allowed');
    }
    if (!net.isIP(hostname) && !hostname.includes('.')) {
      throw new UrlPolicyError('Single-label hostnames are not allowed');
    }
  }
  return { url, hostname, port };
}

/** Resolves a hostname and returns its addresses, rejecting blocked ones unless allowed. */
export async function resolveAllowed(hostname: string, allowPrivate: boolean): Promise<dns.LookupAddress[]> {
  if (net.isIP(hostname)) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new UrlPolicyError('Private, loopback and reserved addresses are not allowed');
    }
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new UrlPolicyError(`Could not resolve host ${hostname}`);
  }
  if (addresses.length === 0) throw new UrlPolicyError(`Could not resolve host ${hostname}`);
  if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
    throw new UrlPolicyError(`Host ${hostname} resolves to a private or reserved address`);
  }
  return addresses;
}

/** Full validation: structure plus DNS resolution. Use when saving an endpoint. */
export async function validateRpcUrlResolved(raw: string, allowPrivate: boolean): Promise<ParsedRpcUrl> {
  const parsed = validateRpcUrl(raw, allowPrivate);
  await resolveAllowed(parsed.hostname, allowPrivate);
  return parsed;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A `lookup` implementation for net/tls connections that refuses blocked
 * addresses at connect time. Supports both single and `all: true` modes.
 */
export function createGuardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate) {
        const bad = list.find((a) => isBlockedAddress(a.address));
        if (bad || list.length === 0) {
          const error: NodeJS.ErrnoException = new UrlPolicyError(`Host ${hostname} resolves to a blocked address`);
          error.code = 'EBLOCKEDADDRESS';
          return callback(error, '', 0);
        }
      }
      const first = list[0];
      if (options.all) return callback(null, list);
      return callback(null, first?.address ?? '', first?.family ?? 4);
    });
  };
}
