import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { absoluteDownloadUrl } from '@/lib/download-response';
import { jsonError, parseId, readJson } from '@/lib/http';
import {
  createStashOverride,
  installStarterTileBundle,
  listStashOverrides,
  stashOverrideSchema
} from '@/lib/stash-overrides';
import { isJsonObject } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string }> };

function withBaseUrl(request: Request, listing: ReturnType<typeof listStashOverrides>) {
  return {
    ...listing,
    baseUrl: listing.basePath ? absoluteDownloadUrl(request, listing.basePath) : null
  };
}

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    return NextResponse.json(withBaseUrl(request, listStashOverrides(parseId(profileId))));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const id = parseId(profileId);
    const body = await readJson(request);
    if (isJsonObject(body) && body.preset === 'starter-tiles') {
      const installed = installStarterTileBundle(id);
      return NextResponse.json({
        installed: installed.length,
        ...withBaseUrl(request, listStashOverrides(id))
      }, { status: 201 });
    }
    const item = createStashOverride(id, stashOverrideSchema.parse(body));
    return NextResponse.json({
      item,
      ...withBaseUrl(request, listStashOverrides(id))
    }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
