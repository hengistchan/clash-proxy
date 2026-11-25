import { jsonError } from '@/lib/http';
import { managedProxySource } from '@/lib/managed-proxy-source';
import { formatSubscriptionUserinfo } from '@/lib/upstream-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ capability: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  try {
    const result = await managedProxySource((await context.params).capability);
    const userinfo = result.userinfo ? formatSubscriptionUserinfo(result.userinfo) : '';
    return new Response(result.yaml, { headers: {
      ...headers, 'Content-Type': 'application/yaml; charset=utf-8',
      'X-Proxy-Source-Status': result.stale ? 'stale' : 'fresh',
      ...(userinfo ? { 'Subscription-Userinfo': userinfo } : {})
    } });
  } catch (error) {
    const response = jsonError(error);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}
