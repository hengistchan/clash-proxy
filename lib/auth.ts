import { timingSafeEqual } from 'node:crypto';

import { HttpError } from './http';

function tokenMatches(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireAdmin(request: Request): void {
  const expected = process.env.STASH_ADMIN_TOKEN?.trim();
  if (!expected) {
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
