import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

import { getLatestConfig } from '@/lib/delivery';
import { rejectLegacyParameters, yamlDownload } from '@/lib/download-response';
export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    rejectLegacyParameters(request);
    return yamlDownload(
      getLatestConfig(parseId((await context.params).profileId))
    );
  } catch (error) {
    return jsonError(error);
  }
}
