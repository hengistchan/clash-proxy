import { revisionEtag } from '@/lib/revision-control';
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { getSnapshot, getCompilationSnapshot } from '@/lib/repository';
import { validateSnapshot } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ profileId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const snapshot = getSnapshot(parseId(profileId));
    return NextResponse.json({
      ...snapshot,
      validation: validateSnapshot(getCompilationSnapshot(snapshot.profile.id))
    }, { headers: { ETag: revisionEtag(snapshot.profile.revision) } });
  } catch (error) {
    return jsonError(error);
  }
}
