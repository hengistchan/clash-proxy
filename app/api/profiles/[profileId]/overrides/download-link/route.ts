import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { absoluteDownloadUrl } from '@/lib/download-response';
import { jsonError, parseId } from '@/lib/http';
import {
  listStashOverrides,
  revokeOverrideToken,
  rotateOverrideToken
} from '@/lib/stash-overrides';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const id = parseId(profileId);
    rotateOverrideToken(id);
    const listing = listStashOverrides(id);
    return NextResponse.json({
      ...listing,
      baseUrl: listing.basePath ? absoluteDownloadUrl(request, listing.basePath) : null
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    revokeOverrideToken(parseId(profileId));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
