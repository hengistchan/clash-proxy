import { withProfileRevision } from '@/lib/revision-control';
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { deleteProfile, getProfile, updateProfile } from '@/lib/repository';
import { profileUpdateSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    return NextResponse.json(getProfile(parseId(profileId)));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = profileUpdateSchema.parse(await readJson(request));
    return withProfileRevision(request, parseId(profileId), () => {
      return NextResponse.json(updateProfile(parseId(profileId), input));
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    return withProfileRevision(request, parseId(profileId), () => {
      deleteProfile(parseId(profileId));
      return new Response(null, { status: 204 });
    });
  } catch (error) {
    return jsonError(error);
  }
}
