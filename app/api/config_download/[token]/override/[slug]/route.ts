import { absoluteDownloadUrl } from '@/lib/download-response';
import { jsonError } from '@/lib/http';
import { overrideForToken } from '@/lib/stash-overrides';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ token: string; slug: string }> };

export async function GET(request: Request, context: Context) {
  const securityHeaders = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  };
  try {
    const { token, slug } = await context.params;
    const baseUrl = absoluteDownloadUrl(request, `/api/config_download/${token}/override`);
    const item = overrideForToken(token, slug, baseUrl);
    return new Response(item.content, {
      status: 200,
      headers: {
        ...securityHeaders,
        'Content-Type': item.contentType,
        'Content-Disposition': `inline; filename="${item.slug}"`
      }
    });
  } catch (error) {
    const response = jsonError(error);
    for (const [key, value] of Object.entries(securityHeaders)) response.headers.set(key, value);
    return response;
  }
}
