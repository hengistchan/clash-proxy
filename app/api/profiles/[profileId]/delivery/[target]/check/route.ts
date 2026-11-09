import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { profileDeliveryTargets } from '@/lib/config-delivery-adapters';
import { HttpError, jsonError, parseId } from '@/lib/http';
import { managedProxySource } from '@/lib/managed-proxy-source';
import { isManagedSourceTarget, sourceCapability } from '@/lib/managed-source-access';
import { getCompilationSnapshot } from '@/lib/repository';
import { refreshShadowrocketUpstream } from '@/lib/shadowrocket-delivery';
import { managedSources, servedRecord } from '@/lib/target-publication-store';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ profileId: string; target: string }> }) {
  try {
    requireAdmin(request);
    const { profileId, target } = await context.params;
    const id = parseId(profileId);
    getCompilationSnapshot(id);
    if (target === 'shadowrocket') await refreshShadowrocketUpstream(id);
    else if (isManagedSourceTarget(target)) {
      const db = getDb();
      const sources = managedSources(servedRecord(db, id, target));
      // Cache/health are updated by the same bounded refresh path used by devices.
      const selected = new URL(request.url).searchParams.get('sourceId');
      const checks = selected === null ? sources.slice(0, 8) : sources.filter(source => source.id === parseId(selected));
      if (selected !== null && !checks.length) throw new HttpError(404, 'Managed source not found');
      await Promise.all(checks.map(async source => {
        try { await managedProxySource(sourceCapability(db, id, source.id, target)); }
        catch (error) {
          if (!(error instanceof HttpError) || ![404, 502, 503].includes(error.status)) throw error;
        }
      }));
    } else throw new HttpError(404, 'Unknown client');
    return Response.json({ targets: profileDeliveryTargets(request, id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
