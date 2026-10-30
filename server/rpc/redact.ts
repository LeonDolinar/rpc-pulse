/**
 * Helpers for keeping RPC credentials out of API responses, logs and stored results.
 * Providers embed API keys in the path (Alchemy, Infura, Ankr, Chainstack, QuickNode),
 * in query parameters, or in userinfo, so all three are masked.
 */

const MASK = '••••';

function isSecretLike(segment: string): boolean {
  if (segment.length >= 16) return true;
  return segment.length >= 8 && /\d/.test(segment) && /[a-zA-Z]/.test(segment);
}

function maskSegment(segment: string): string {
  return segment.slice(0, 4) + MASK;
}

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[invalid url]';
  }
  let out = `${url.protocol}//`;
  if (url.username || url.password) out += `${MASK}@`;
  out += url.host;
  const path = url.pathname
    .split('/')
    .map((segment) => (isSecretLike(decodeURIComponent(segment)) ? maskSegment(segment) : segment))
    .join('/');
  if (path !== '/') out += path;
  const keys = [...url.searchParams.keys()];
  if (keys.length > 0) out += '?' + keys.map((k) => `${k}=${MASK}`).join('&');
  return out;
}

/** Collects every substring of a URL that could reveal a credential. */
function secretFragments(raw: string): string[] {
  const fragments = new Set<string>([raw]);
  try {
    const url = new URL(raw);
    fragments.add(url.href);
    if (url.username) fragments.add(url.username);
    if (url.password) fragments.add(url.password);
    for (const segment of url.pathname.split('/')) {
      if (segment.length >= 6) {
        fragments.add(segment);
        fragments.add(decodeURIComponent(segment));
      }
    }
    for (const value of url.searchParams.values()) if (value.length >= 4) fragments.add(value);
    if (url.search) fragments.add(url.search);
  } catch {
    // Unparseable: only the raw string is scrubbed.
  }
  // Longest first so a full URL is replaced before its parts.
  return [...fragments].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Removes any part of `secretUrl` from a message and bounds its length. */
export function sanitizeMessage(message: string, secretUrl: string, maxLength = 300): string {
  let out = message;
  for (const fragment of secretFragments(secretUrl)) {
    out = out.split(fragment).join(MASK);
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > maxLength ? out.slice(0, maxLength - 1) + '…' : out;
}
