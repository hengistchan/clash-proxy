import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { absoluteDownloadUrl, rejectLegacyParameters, yamlDownload } from '@/lib/download-response';
import { HttpError, jsonError, parseId } from '@/lib/http';
import { sourceCapability, verifySourceCapability } from '@/lib/managed-source-access';
import { sourceFingerprints } from '@/lib/managed-source-health';
import { exportMihomo } from '@/lib/mihomo-export';
import { getCompilationSnapshot } from '@/lib/repository';
import { managedSources, servedStashRecord } from '@/lib/target-publication-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    requireAdmin(request);
    rejectLegacyParameters(request);
    const profileId = parseId((await context.params).profileId);
    const snapshot = getCompilationSnapshot(profileId);
    const db = getDb();
    const artifact = db.transaction(() => {
      const served = snapshot.proxyProviders.some(provider => provider.rewriteRules?.length)
        ? new Map(managedSources(servedStashRecord(db, profileId)).map(source => [source.id, sourceFingerprints(source).specKey]))
        : new Map<number, string>();
      return exportMihomo(snapshot, source => {
        if (served.get(source.id) !== sourceFingerprints(source).specKey) return;
        const capability = sourceCapability(db, profileId, source.id);
        try { verifySourceCapability(db, capability); }
        catch (error) {
          if (error instanceof HttpError && error.status === 404) return;
          throw error;
        }
        return absoluteDownloadUrl(request, `/api/proxy-source/${capability}/proxies.yaml`);
      });
    })();
    return yamlDownload(artifact);
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
}
