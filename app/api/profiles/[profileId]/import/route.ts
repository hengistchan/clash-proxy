import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getCompilationSnapshot, importYaml } from '@/lib/repository';
import { validateSnapshot } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const importSchema = z.object({
  yaml: z.string().min(1)
});

export async function POST(
  request: Request,
  context: { params: Promise<{ profileId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = importSchema.parse(await readJson(request));
    const snapshot = importYaml(parseId(profileId), input.yaml);
    return NextResponse.json({
      ...snapshot,
      validation: validateSnapshot(getCompilationSnapshot(snapshot.profile.id))
    });
  } catch (error) {
    return jsonError(error);
  }
}
