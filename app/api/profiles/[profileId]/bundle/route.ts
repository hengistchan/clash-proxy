import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

import { getLatestConfig } from '@/lib/delivery';
import { materializeYamlArtifact } from '@/lib/managed-proxy-source';
import { zipFiles } from '@/lib/zip';
export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const artifact = materializeYamlArtifact(getLatestConfig(parseId((await context.params).profileId)), request);
    const bytes = zipFiles({
      'config.yaml': artifact.yaml,
      'manifest.json': JSON.stringify(
        {
          revision: artifact.revision,
          currentRevision: artifact.currentRevision,
          sha256: artifact.sha256,
          generatedAt: artifact.generatedAt,
          format: 'stash-yaml',
          remoteDependencies:
            'The configuration includes provider URLs and local resource paths. Resources are not fetched or bundled.'
        },
        null,
        2
      ),
      'diagnostics.json': JSON.stringify(artifact.validation, null, 2),
      'README.txt':
        'Import config.yaml into Stash. This private file may contain subscription credentials. Remote providers still require network access; local resource paths must already exist in Stash. This ZIP is a delivery package, not an offline resource bundle.\n'
    });
    return new Response(bytes as BodyInit, {
      headers: {
        'X-Config-Revision': String(artifact.revision),
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="config-${artifact.revision}.zip"`,
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
