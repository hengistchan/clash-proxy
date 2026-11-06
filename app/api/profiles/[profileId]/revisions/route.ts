import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { HttpError, jsonError, parseId } from '@/lib/http';
import { listRevisions } from '@/lib/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ profileId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const url = new URL(request.url);
    const limitText = url.searchParams.get('limit');
    const beforeText = url.searchParams.get('before');
    if (
      (limitText !== null && !/^\d+$/.test(limitText)) ||
      (beforeText !== null && !/^\d+$/.test(beforeText))
    ) {
      throw new HttpError(400, 'Revision paging values must be positive integers');
    }
    const limit = limitText === null ? 50 : Number(limitText);
    const before = beforeText === null ? undefined : Number(beforeText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'Revision page limit must be between 1 and 100');
    }
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      throw new HttpError(400, 'Revision cursor must be a positive integer');
    }
    return NextResponse.json(
      listRevisions(parseId(profileId), { limit, before })
    );
  } catch (error) {
    return jsonError(error);
  }
}
