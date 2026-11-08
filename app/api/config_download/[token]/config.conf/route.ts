import { confDownload, rejectLegacyParameters } from '@/lib/download-response';
import { jsonError } from '@/lib/http';
import { shadowrocketConfigForToken } from '@/lib/shadowrocket-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    rejectLegacyParameters(request);
    return confDownload(await shadowrocketConfigForToken((await context.params).token));
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
}
