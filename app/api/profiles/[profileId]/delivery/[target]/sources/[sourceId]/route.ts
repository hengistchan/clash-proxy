import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { profileDeliveryTargets } from '@/lib/config-delivery-adapters';
import { HttpError, jsonError, parseId } from '@/lib/http';
import { setSourceAccess } from '@/lib/managed-source-access';
import { managedSources, servedStashRecord } from '@/lib/target-publication-store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ profileId: string; target: string; sourceId: string }> };

async function change(request: Request, context: Context, enabled: boolean) {
  try {
    requireAdmin(request);
    const params = await context.params;
    const profileId = parseId(params.profileId), sourceId = parseId(params.sourceId);
    if (params.target !== 'stash') throw new HttpError(404, 'Managed source not found');
    const db = getDb();
    return db.transaction(() => {
      if (!managedSources(servedStashRecord(db, profileId)).some(source => source.id === sourceId)) {
        throw new HttpError(404, 'Managed source not found');
      }
      setSourceAccess(db, profileId, sourceId, enabled);
      return Response.json({ targets: profileDeliveryTargets(request, profileId) }, { headers: { 'Cache-Control': 'no-store' } });
    }).immediate();
  } catch (error) {
    return jsonError(error);
  }
}

export function POST(request: Request, context: Context) {
  return change(request, context, true);
}

export function DELETE(request: Request, context: Context) {
  return change(request, context, false);
}
