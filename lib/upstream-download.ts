import { lookup } from 'node:dns/promises';
import { request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { validateSubscriptionUrl } from './provider-source';
import { isJsonObject, type JsonObject } from './types';

const MAX_BYTES = 2 * 1024 * 1024;
type Address = { address: string; family: number };
type DownloadResponse = { redirect: string } | { text: string };
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]
] as const) blocked.addSubnet(network, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) return !address.includes('%') && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  return false;
}

export class PrivateSourceAddressError extends Error {
  constructor() {
    super('Private source address');
  }
}

const disallowedHeaders = new Set([
  'host', 'connection', 'proxy-authorization', 'proxy-connection', 'content-length', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'expect', 'accept-encoding'
]);

function sourceHeaders(input: unknown) {
  const headers: Record<string, string | string[]> = Object.create(null);
  if (input === undefined) return headers;
  if (!isJsonObject(input) || Object.keys(input).length > 32) throw new Error('Invalid source headers');
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    const values = Array.isArray(value) ? value : [value];
    if (disallowedHeaders.has(name) || name in headers || !values.length || values.length > 16 ||
      !values.every((item) => typeof item === 'string' && item.length <= 4096)) throw new Error('Invalid source headers');
    validateHeaderName(name);
    for (const item of values as string[]) validateHeaderValue(name, item);
    headers[name] = Array.isArray(value) ? values as string[] : value as string;
  }
  return headers;
}

async function pinAddress(target: URL, signal: AbortSignal) {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicSourceAddress(host)) throw new PrivateSourceAddressError();
    return { address: host, family: isIP(host) };
  }
  const addresses = await new Promise<Address[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    resolveAll(host, signal).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
  if (!addresses.length) throw new Error('No source address');
  if (addresses.some(({ address }) => !isPublicSourceAddress(address))) throw new PrivateSourceAddressError();
  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

async function resolveAll(host: string, signal: AbortSignal): Promise<Address[]> {
  const endpoint = process.env.STASH_UPSTREAM_DOH_URL?.trim();
  if (!endpoint) return lookup(host, { all: true });
  const domain = host.toLowerCase().replace(/\.$/, '');
  if (!domain.includes('.') || /\.(localhost|local|internal|home\.arpa)$/.test(domain)) throw new PrivateSourceAddressError();
  const resolver = new URL(endpoint);
  if (resolver.protocol !== 'https:' || resolver.username || resolver.password || resolver.search || resolver.hash ||
    !isPublicSourceAddress(resolver.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('Invalid DNS resolver');
  }
  const results = await Promise.all(([1, 28] as const).map(async (type): Promise<Address[]> => {
    const query = new URL(resolver);
    query.searchParams.set('name', domain);
    query.searchParams.set('type', String(type));
    const response = await get(query, { accept: 'application/dns-json', 'accept-encoding': 'identity' }, signal);
    if (!('text' in response)) throw new Error('Invalid DNS redirect');
    const result: unknown = JSON.parse(response.text);
    if (!isJsonObject(result) || result.Status !== 0 || result.TC === true ||
      (result.Answer !== undefined && !Array.isArray(result.Answer))) throw new Error('Invalid DNS response');
    const answers = result.Answer ?? [];
    return answers.flatMap((answer) => {
      if (!isJsonObject(answer) || answer.type !== type) return [];
      const family = type === 1 ? 4 : 6;
      if (typeof answer.data !== 'string' || isIP(answer.data) !== family) throw new Error('Invalid DNS address');
      return [{ address: answer.data, family }];
    });
  }));
  return results.flat();
}

async function get(target: URL, headers: Record<string, string | string[]>, signal: AbortSignal): Promise<DownloadResponse> {
  signal.throwIfAborted();
  const { address, family } = await pinAddress(target, signal);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<DownloadResponse>((resolve, reject) => {
    const req = request(target, {
      agent: false,
      family,
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers,
      signal
    }, (response) => {
      response.on('error', reject);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        resolve({ redirect: response.headers.location });
        response.destroy();
        return;
      }
      if (status !== 200 || Number(response.headers['content-length']) > MAX_BYTES ||
        (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(new Error('Invalid upstream response'));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) response.destroy(new Error('Upstream response too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve({ text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export type SourceDownload = (config: JsonObject, signal: AbortSignal) => Promise<string>;

export const downloadSource: SourceDownload = async (config, signal) => {
  if (typeof config.url !== 'string') throw new Error('Missing source URL');
  let target = new URL(validateSubscriptionUrl(config.url));
  const custom = sourceHeaders(config.headers);
  const authenticated = Boolean(target.username || target.password || Object.keys(custom).length);
  if (target.username || target.password) {
    custom.authorization = 'Basic ' + Buffer.from(decodeURIComponent(target.username) + ':' + decodeURIComponent(target.password)).toString('base64');
    target.username = '';
    target.password = '';
  }
  const headers = { 'user-agent': 'Stash Config Forge', ...custom, 'accept-encoding': 'identity' };
  for (let attempt = 0; attempt <= 3; attempt++) {
    const result = await get(target, headers, signal);
    if ('text' in result) return result.text;
    const redirected = new URL(validateSubscriptionUrl(new URL(result.redirect, target).href));
    if (redirected.username || redirected.password ||
      (target.protocol === 'https:' && redirected.protocol !== 'https:') ||
      (authenticated && target.origin !== redirected.origin)) throw new Error('Unsafe upstream redirect');
    target = redirected;
  }
  throw new Error('Too many upstream redirects');
};
