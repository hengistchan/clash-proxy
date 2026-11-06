import { configForToken } from '@/lib/delivery';
import {
  absoluteDownloadUrl,
  rejectLegacyParameters,
  yamlDownload
} from '@/lib/download-response';
import { jsonError } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  try {
    rejectLegacyParameters(request);
    const url = new URL(request.url);
    url.search = '';
    url.hash = '';
    return yamlDownload(
      configForToken((await context.params).token),
      absoluteDownloadUrl(request, url.pathname)
    );
  } catch (error) {
    return jsonError(error);
  }
}
