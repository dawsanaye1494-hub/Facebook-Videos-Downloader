import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');

function getSigningSecret(): string {
  const configured = process.env.DOWNLOAD_TOKEN_SECRET?.trim();
  return configured && configured.length >= 16 ? configured : EPHEMERAL_SECRET;
}

const ALLOWED_FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'web.facebook.com',
  'fb.watch',
  'www.fb.watch',
  'fb.com',
  'www.fb.com',
  'l.facebook.com',
  'lm.facebook.com',
]);

const ALLOWED_CDN_SUFFIXES = [
  '.fbcdn.net',
  '.fbsbx.com',
  '.facebook.com',
  '.akamaihd.net',
  '.cdninstagram.com',
];

export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();

  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIp(mapped);
    }
  }

  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(clean)) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true;
    if (
      clean.startsWith('fe80') ||
      clean.startsWith('fe9') ||
      clean.startsWith('fea') ||
      clean.startsWith('feb')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

export function isAllowedFacebookHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (ALLOWED_FACEBOOK_HOSTS.has(host)) return true;
  return host.endsWith('.facebook.com') || host.endsWith('.fb.watch');
}

export function isAllowedCdnHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (isAllowedFacebookHost(host)) return true;
  return ALLOWED_CDN_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

export async function assertSafePublicHost(hostname: string, allowCdn: boolean): Promise<void> {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Local or internal hostnames are not permitted.');
  }

  if (net.isIP(host) !== 0) {
    throw new Error('Direct IP addresses are not permitted.');
  }

  const allowed = allowCdn ? isAllowedCdnHost(host) : isAllowedFacebookHost(host);
  if (!allowed) {
    throw new Error('Only public Facebook and Facebook CDN domains are permitted.');
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records || records.length === 0) {
    throw new Error('Could not resolve host address.');
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error('Resolved network address is not a public endpoint.');
    }
  }
}

export function normalizeAndValidateFacebookUrl(rawInput: string, depth = 0): URL {
  if (depth > 2) {
    throw new Error('Too many link redirects in Facebook URL.');
  }

  let trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('Please enter a Facebook video URL.');
  }

  if (trimmed.length > 2048) {
    throw new Error('URL exceeds maximum allowed length.');
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    if (/^(?:www\.|m\.|mbasic\.|web\.)?(?:facebook\.com|fb\.watch|fb\.com)\//i.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    } else {
      throw new Error('URL must begin with https:// and point to Facebook.');
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS protocols are supported.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not allowed.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!isAllowedFacebookHost(host)) {
    throw new Error('Please enter a valid Facebook URL (facebook.com or fb.watch).');
  }

  if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && parsed.searchParams.has('u')) {
    const inner = parsed.searchParams.get('u') || '';
    return normalizeAndValidateFacebookUrl(inner, depth + 1);
  }

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  }

  return parsed;
}

export interface MediaTokenPayload {
  kind: 'download' | 'thumbnail';
  videoUrl: string;
  audioUrl?: string;
  mode: 'direct' | 'mux' | 'm4a' | 'mp3' | 'thumbnail';
  filename: string;
  mimeType: string;
  exp: number;
}

const MAX_TOKEN_STORE_SIZE = 5000;
const tokenStore = new Map<string, MediaTokenPayload>();

function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [id, payload] of tokenStore.entries()) {
    if (payload.exp < now) {
      tokenStore.delete(id);
    }
  }
  while (tokenStore.size >= MAX_TOKEN_STORE_SIZE) {
    const oldestKey = tokenStore.keys().next().value;
    if (!oldestKey) break;
    tokenStore.delete(oldestKey);
  }
}

export function signMediaToken(payload: Omit<MediaTokenPayload, 'exp'>, ttlMs = 45 * 60 * 1000): string {
  pruneExpiredTokens();
  const id = crypto.randomBytes(16).toString('base64url');
  const fullPayload: MediaTokenPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  tokenStore.set(id, fullPayload);
  const sig = crypto.createHmac('sha256', getSigningSecret()).update(id).digest('base64url');
  return `${id}.${sig}`;
}

export function verifyMediaToken(token: string): MediaTokenPayload {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Missing or malformed media token.');
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid media token structure.');
  }

  const [id, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getSigningSecret()).update(id).digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid media token signature.');
  }

  const parsed = tokenStore.get(id);
  if (!parsed) {
    throw new Error('Download session expired or server restarted. Please click Analyze Video again.');
  }

  if (parsed.exp < Date.now()) {
    tokenStore.delete(id);
    throw new Error('Download session expired. Please click Analyze Video again.');
  }

  if (!parsed.videoUrl || !isAllowedCdnHost(new URL(parsed.videoUrl).hostname)) {
    throw new Error('Untrusted media source URL.');
  }

  if (parsed.audioUrl && !isAllowedCdnHost(new URL(parsed.audioUrl).hostname)) {
    throw new Error('Untrusted audio source URL.');
  }

  return parsed;
}

export function stripLoneSurrogates(input: string): string {
  return input.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function sanitizeFilename(rawName: string, extension: string): string {
  const wellFormed = stripLoneSurrogates(rawName);
  const cleaned = wellFormed
    .replace(/[\r\n\t\0/\\:*?"<>|;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const safeTruncated = Array.from(cleaned).slice(0, 80).join('').trim();
  const base = safeTruncated || 'facebook-video';
  const ext = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
  return `${base}.${ext}`;
}
