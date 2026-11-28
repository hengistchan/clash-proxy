import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEncryptionKey } from './crypto';
import { HttpError } from './http';
import { downloadSource, type SourceDownload } from './upstream-download';

export const PUBLIC_RULE_HOSTS = new Set([
  'raw.githubusercontent.com',
  'ruleset.skk.moe',
  'ruleset-mirror.skk.moe'
]);
const MAX_ENTRIES = 32;
const CACHE_MS = 15 * 60_000;
const RETRY_MS = 30_000;

export function publicRuleUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 1024 || !URL.canParse(value)) return;
  const url = new URL(value);
  const minSegments = url.host === 'raw.githubusercontent.com' ? 5 : 3;
  if (url.protocol === 'https:' && PUBLIC_RULE_HOSTS.has(url.host) && !url.username && !url.password &&
      !url.search && !url.hash && url.href.length <= 1024 && url.pathname.split('/').length >= minSegments) return url;
}

export const publicGitHubRuleUrl = publicRuleUrl;

function signature(encoded: string) {
  return createHmac('sha256', getEncryptionKey()).update('mihomo-public-rule:').update(encoded).digest();
}

export function ruleMirrorCapability(url: URL) {
  const encoded = Buffer.from(url.href).toString('base64url');
  return `r1.${encoded}.${signature(encoded).toString('hex')}`;
}

function upstreamFor(capability: string) {
  const match = /^r1\.([\w-]{1,1366})\.([a-f0-9]{64})$/.exec(capability);
  const missing = () => new HttpError(404, 'Rule source link not found');
  if (!match) throw missing();
  const [, encoded, mac] = match;
  if (!timingSafeEqual(signature(encoded), Buffer.from(mac, 'hex'))) throw missing();
  const upstream = publicGitHubRuleUrl(Buffer.from(encoded, 'base64url').toString());
  if (!upstream) throw missing();
  return upstream.href;
}

interface CachedRuleSource {
  text: string;
  refreshAt: number;
}

const cache = new Map<string, CachedRuleSource>();
const inFlight = new Map<string, Promise<string>>();

export async function mirroredRuleSource(capability: string, fetchSource: SourceDownload = downloadSource) {
  const upstream = upstreamFor(capability);
  const cached = cache.get(upstream);
  if (cached && cached.refreshAt > Date.now()) return cached.text;
  const pending = inFlight.get(upstream);
  if (pending) return pending;
  if (inFlight.size >= MAX_ENTRIES) {
    if (cached) return cached.text;
    throw new HttpError(503, 'Rule source refresh is busy');
  }
  const work = Promise.resolve().then(async () => {
    try {
      const text = await fetchSource({ url: upstream, headers: { accept: 'text/plain' } }, AbortSignal.timeout(8_000));
      if (!text.trim() || /^\s*<(?:!doctype|html)/i.test(text)) throw new Error('Invalid rule source');
      cache.delete(upstream);
      cache.set(upstream, { text, refreshAt: Date.now() + CACHE_MS });
      if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return text;
    } catch {
      if (cached) {
        cached.refreshAt = Date.now() + RETRY_MS;
        return cached.text;
      }
      throw new HttpError(502, 'Rule source is temporarily unavailable');
    } finally {
      inFlight.delete(upstream);
    }
  });
  inFlight.set(upstream, work);
  return work;
}
