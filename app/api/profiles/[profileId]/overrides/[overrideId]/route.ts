import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import {
  deleteStashOverride,
  stashOverrideSchema,
  updateStashOverride
} from '@/lib/stash-overrides';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string; overrideId: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, overrideId } = await context.params;
    const input = stashOverrideSchema.parse(await readJson(request));
    const item = updateStashOverride(parseId(profileId), parseId(overrideId), input);
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, overrideId } = await context.params;
    deleteStashOverride(parseId(profileId), parseId(overrideId));
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
