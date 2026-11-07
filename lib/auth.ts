import { timingSafeEqual } from 'node:crypto';

import { HttpError } from './http';
import { allowsInsecureLocalDevelopment, isLoopbackHost } from '../Scripts/runtime-security.mjs';

function requireLocalRequest(request: Request): void {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  let hostIsLocal = true;
  try {
    if (host) hostIsLocal = isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    hostIsLocal = false;
  }
  if (!isLoopbackHost(url.hostname) || !hostIsLocal) {
    throw new HttpError(403, 'Unauthenticated development access is restricted to loopback hosts');
  }
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== url.origin) || (site && !['same-origin', 'none'].includes(site))) {
    throw new HttpError(403, 'Cross-origin access is not allowed in unauthenticated development mode');
  }
}

function tokenMatches(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireAdmin(request: Request): void {
  const expected = process.env.STASH_ADMIN_TOKEN?.trim();
  if (!expected) {
    if (!allowsInsecureLocalDevelopment()) {
      throw new HttpError(503, 'Administrator authentication is not configured');
    }
    requireLocalRequest(request);
    return;
  }
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : (request.headers.get('x-admin-token') || '').trim();
  if (!supplied || !tokenMatches(supplied, expected)) {
    throw new HttpError(401, 'A valid admin token is required');
  }
}
