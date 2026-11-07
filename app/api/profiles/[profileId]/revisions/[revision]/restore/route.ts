import { withProfileRevision } from '@/lib/revision-control';
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { getCompilationSnapshot, restoreRevision } from '@/lib/repository';
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
    return withProfileRevision(request, parseId(profileId), () => {
      const snapshot = restoreRevision(parseId(profileId), parseId(revision));
      return NextResponse.json({
        ...snapshot,
        validation: validateSnapshot(getCompilationSnapshot(snapshot.profile.id))
      });
    });
  } catch (error) {
    return jsonError(error);
  }
}
