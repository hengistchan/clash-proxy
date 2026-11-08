import { withProfileRevision } from '@/lib/revision-control';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getCompilationSnapshot, importYaml } from '@/lib/repository';
import { validateSnapshot } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const importSchema = z.object({
  yaml: z.string().min(1),
  previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional()
});

export async function POST(
  request: Request,
  context: { params: Promise<{ profileId: string }> }
) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = importSchema.parse(await readJson(request));
    return withProfileRevision(request, parseId(profileId), () => {
      const snapshot = importYaml(parseId(profileId), input.yaml, input.previewFingerprint);
      return NextResponse.json({
        ...snapshot,
        validation: validateSnapshot(getCompilationSnapshot(snapshot.profile.id))
      });
    });
  } catch (error) {
    return jsonError(error);
  }
}
