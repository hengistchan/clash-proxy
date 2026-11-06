import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getSnapshot } from '@/lib/repository';
import {
  asResourceKind,
  createResource,
  listResources
} from '@/lib/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string; resource: string }> };

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, resource } = await context.params;
    const kind = asResourceKind(resource);
    return NextResponse.json({
      items: listResources(getSnapshot(parseId(profileId)), kind)
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, resource } = await context.params;
    const kind = asResourceKind(resource);
    return NextResponse.json(
      createResource(parseId(profileId), kind, await readJson(request)),
      { status: 201 }
    );
  } catch (error) {
    return jsonError(error);
  }
}
