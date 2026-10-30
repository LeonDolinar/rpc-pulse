import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../server/crypto.js';
import { isBlockedAddress, UrlPolicyError, validateRpcUrl, validateRpcUrlResolved } from '../server/rpc/net-policy.js';
import { redactUrl, sanitizeMessage } from '../server/rpc/redact.js';

describe('redactUrl', () => {
  it('masks provider keys in paths', () => {
    expect(redactUrl('https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUv')).toBe('https://eth-mainnet.g.alchemy.com/v2/AbCd••••');
    expect(redactUrl('https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef')).toBe('https://mainnet.infura.io/v3/0123••••');
    expect(redactUrl('https://rpc.ankr.com/eth')).toBe('https://rpc.ankr.com/eth');
  });

  it('masks query values and userinfo', () => {
    expect(redactUrl('https://user:pass@node.example.com/rpc?apikey=secret&x=1')).toBe('https://••••@node.example.com/rpc?apikey=••••&x=••••');
  });

  it('sanitizes messages containing the URL or key', () => {
    const url = 'https://nd-1.p2pify.com/abcdef0123456789abcdef';
    const msg = sanitizeMessage(`connect failed for ${url} (key abcdef0123456789abcdef)`, url);
    expect(msg).not.toContain('abcdef0123456789abcdef');
    expect(msg).toContain('••••');
  });
});

describe('network policy', () => {
  it('blocks private and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('rejects disallowed URLs', () => {
    const bad = ['ftp://example.com', 'file:///etc/passwd', 'http://localhost:8545', 'http://127.0.0.1:8545', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://node.internal/', 'http://intranet/', 'not a url', 'https://example.com/#frag'];
    for (const url of bad) expect(() => validateRpcUrl(url, false), url).toThrow(UrlPolicyError);
  });

  it('accepts public URLs and private ones when allowed', () => {
    expect(validateRpcUrl('https://rpc.example.com/v1/key', false).port).toBe(443);
    expect(validateRpcUrl('http://127.0.0.1:8545', true).port).toBe(8545);
  });

  it('rejects hostnames resolving to private addresses', async () => {
    await expect(validateRpcUrlResolved('http://localtest.me/', false)).rejects.toThrow(UrlPolicyError);
  });
});

describe('secret encryption', () => {
  it('round-trips and detects tampering', () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret('https://x.example/v2/key', key);
    expect(enc).not.toContain('key');
    expect(decryptSecret(enc, key)).toBe('https://x.example/v2/key');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
    expect(() => decryptSecret(enc, crypto.randomBytes(32))).toThrow();
  });
});
