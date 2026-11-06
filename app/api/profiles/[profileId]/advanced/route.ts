import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getSnapshot, replaceAdvancedSections } from '@/lib/repository';
import { advancedSchema } from '@/lib/schemas';
import type { JsonValue } from '@/lib/types';
import { validateSnapshot } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    return NextResponse.json({
      items: getSnapshot(parseId(profileId)).advancedSections
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = advancedSchema.parse(await readJson(request));
    const id = parseId(profileId);
    const items = replaceAdvancedSections(
      id,
      input.sections as Array<{ key: string; value: JsonValue }>
    );
    return NextResponse.json({
      items,
      validation: validateSnapshot(getSnapshot(id))
    });
  } catch (error) {
    return jsonError(error);
  }
}
