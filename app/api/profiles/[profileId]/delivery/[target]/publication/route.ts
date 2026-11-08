import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { configTargetIds, type ConfigTarget } from '@/lib/config-targets';
import { profileDeliveryTargets } from '@/lib/config-delivery-adapters';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getCompilationSnapshot } from '@/lib/repository';
import { withProfileRevision } from '@/lib/revision-control';
import { changeTargetPublication } from '@/lib/target-publication';

export const runtime = 'nodejs';

const input = z.object({
  action: z.enum(['manual', 'auto', 'publish', 'rollback']),
  expectedMode: z.enum(['auto', 'manual']),
  expectedPublicationId: z.number().int().positive().nullable(),
  publicationId: z.number().int().positive().optional()
});

export async function POST(request: Request, context: { params: Promise<{ profileId: string; target: string }> }) {
  try {
    requireAdmin(request);
    const params = await context.params;
    const target = z.enum(configTargetIds as [ConfigTarget, ...ConfigTarget[]]).parse(params.target);
    const id = parseId(params.profileId);
    const command = input.parse(await readJson(request));
    getCompilationSnapshot(id);
    return withProfileRevision(request, id, () => {
      // Bring persisted candidates up to the current compiler before changing the pointer.
      profileDeliveryTargets(request, id);
      changeTargetPublication(getDb(), id, target, command);
      return Response.json({ targets: profileDeliveryTargets(request, id) }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    return jsonError(error);
  }
}
