import { withProfileRevision } from '@/lib/revision-control';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import {
  deleteRuleProviderEntry,
  updateRuleProviderEntry
} from '@/lib/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrySchema = z.object({
  value: z.string().trim().min(1),
  position: z.number().int().positive().optional()
});

export async function PUT(
  request: Request,
  context: {
    params: Promise<{ profileId: string; providerId: string; entryId: string }>;
  }
) {
  try {
    requireAdmin(request);
    const { profileId, providerId, entryId } = await context.params;
    const input = entrySchema.parse(await readJson(request));
    return withProfileRevision(request, parseId(profileId), () => {
      return NextResponse.json(
        updateRuleProviderEntry(
          parseId(profileId),
          parseId(providerId),
          parseId(entryId),
          input
        )
      );
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  request: Request,
  context: {
    params: Promise<{ profileId: string; providerId: string; entryId: string }>;
  }
) {
  try {
    requireAdmin(request);
    const { profileId, providerId, entryId } = await context.params;
    return withProfileRevision(request, parseId(profileId), () => {
      deleteRuleProviderEntry(
        parseId(profileId),
        parseId(providerId),
        parseId(entryId)
      );
      return new Response(null, { status: 204 });
    });
  } catch (error) {
    return jsonError(error);
  }
}
