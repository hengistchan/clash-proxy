import { withProfileRevision } from '@/lib/revision-control';
import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { reorderRules } from '@/lib/repository';
import { ruleOrderSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  context: { params: Promise<{ profileId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = ruleOrderSchema.parse(await readJson(request));
    return withProfileRevision(request, parseId(profileId), () => {
      return NextResponse.json({
        items: reorderRules(parseId(profileId), input.ids)
      });
    });
  } catch (error) {
    return jsonError(error);
  }
}
