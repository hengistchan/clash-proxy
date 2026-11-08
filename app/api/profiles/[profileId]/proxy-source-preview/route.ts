import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { previewProxySource, proxySourcePreviewSchema } from '@/lib/proxy-source-preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    requireAdmin(request);
    const profileId = parseId((await context.params).profileId);
    const preview = await previewProxySource(profileId, proxySourcePreviewSchema.parse(await readJson(request)));
    return Response.json(preview, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
