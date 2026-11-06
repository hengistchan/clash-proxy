import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { restoreRevision } from '@/lib/repository';
import { validateSnapshot } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ profileId: string; revision: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId, revision } = await context.params;
    const snapshot = restoreRevision(parseId(profileId), parseId(revision));
    return NextResponse.json({
      ...snapshot,
      validation: validateSnapshot(snapshot)
    });
  } catch (error) {
    return jsonError(error);
  }
}
