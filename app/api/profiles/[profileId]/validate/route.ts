import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { getCompilationSnapshot } from '@/lib/repository';
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
    return NextResponse.json(
      validateSnapshot(getCompilationSnapshot(parseId(profileId)))
    );
  } catch (error) {
    return jsonError(error);
  }
}
