import { getDb } from '@/lib/db';
import { absoluteDownloadUrl, rejectLegacyParameters, yamlDownload } from '@/lib/download-response';
import { HttpError, jsonError } from '@/lib/http';
import { materializeYamlArtifact } from '@/lib/managed-proxy-source';
import { mihomoConfigForToken } from '@/lib/mihomo-delivery';
import { portableMihomoYaml } from '@/lib/mihomo-portable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    rejectLegacyParameters(request);
    const { token } = await context.params;
    const artifact = getDb().transaction(() => materializeYamlArtifact(mihomoConfigForToken(token), request, 'mihomo'))();
    const origin = new URL(absoluteDownloadUrl(request, '/')).origin;
    const yaml = await portableMihomoYaml(artifact.yaml, origin);
    const current = getDb().transaction(() => materializeYamlArtifact(mihomoConfigForToken(token), request, 'mihomo'))();
    if (current.sha256 !== artifact.sha256) throw new HttpError(409, '订阅内容在生成期间已变化，请重试。');
    return yamlDownload({ ...artifact, filename: 'mihomo-portable.yaml', yaml });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
}
