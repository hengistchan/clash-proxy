import { withProfileRevision } from '@/lib/revision-control';
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import {
  asResourceKind,
  deleteResource,
  getResource,
  updateResource
} from '@/lib/resources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = {
  params: Promise<{ profileId: string; resource: string; itemId: string }>;
};

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, resource, itemId } = await context.params;
    return NextResponse.json(
      getResource(parseId(profileId), asResourceKind(resource), parseId(itemId))
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, resource, itemId } = await context.params;
    const body = await readJson(request);
    return withProfileRevision(request, parseId(profileId), () => {
      return NextResponse.json(
        updateResource(
          parseId(profileId),
          asResourceKind(resource),
          parseId(itemId),
          body
        )
      );
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId, resource, itemId } = await context.params;
    return withProfileRevision(request, parseId(profileId), () => {
      deleteResource(
        parseId(profileId),
        asResourceKind(resource),
        parseId(itemId)
      );
      return new Response(null, { status: 204 });
    });
  } catch (error) {
    return jsonError(error);
  }
}
