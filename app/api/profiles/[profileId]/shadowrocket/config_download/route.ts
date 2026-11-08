import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { confDownload, rejectLegacyParameters } from '@/lib/download-response';
import { getLatestShadowrocketConfig } from '@/lib/shadowrocket-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    requireAdmin(request);
    rejectLegacyParameters(request);
    return confDownload(await getLatestShadowrocketConfig(parseId((await context.params).profileId)));
  } catch (error) {
    return jsonError(error);
  }
}
