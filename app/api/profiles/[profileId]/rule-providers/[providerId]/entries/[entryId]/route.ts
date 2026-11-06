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
    return NextResponse.json(
      updateRuleProviderEntry(
        parseId(profileId),
        parseId(providerId),
        parseId(entryId),
        entrySchema.parse(await readJson(request))
      )
    );
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
    deleteRuleProviderEntry(
      parseId(profileId),
      parseId(providerId),
      parseId(entryId)
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
