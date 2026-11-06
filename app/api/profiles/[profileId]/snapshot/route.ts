import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { getSnapshot } from '@/lib/repository';
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
      validation: validateSnapshot(snapshot)
    });
  } catch (error) {
    return jsonError(error);
  }
}
