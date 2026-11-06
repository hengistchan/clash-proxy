import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { createRuleProviderEntry, getSnapshot } from '@/lib/repository';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const entrySchema = z.object({
  value: z.string().trim().min(1),
  position: z.number().int().positive().optional()
});

export async function GET(
  request: Request,
  context: { params: Promise<{ profileId: string; providerId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId, providerId } = await context.params;
    const snapshot = getSnapshot(parseId(profileId));
    const provider = snapshot.ruleProviders.find(
      (item) => item.id === parseId(providerId)
    );
    if (!provider) {
      return NextResponse.json({ detail: 'Rule provider not found' }, { status: 404 });
    }
    return NextResponse.json({ items: provider.entries });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ profileId: string; providerId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId, providerId } = await context.params;
    const input = entrySchema.parse(await readJson(request));
    return NextResponse.json(
      createRuleProviderEntry(parseId(profileId), parseId(providerId), input),
      { status: 201 }
    );
  } catch (error) {
    return jsonError(error);
  }
}
