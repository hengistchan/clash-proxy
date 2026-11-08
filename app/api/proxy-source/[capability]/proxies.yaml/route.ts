import { jsonError } from '@/lib/http';
import { managedProxySource } from '@/lib/managed-proxy-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ capability: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  try {
    const result = await managedProxySource((await context.params).capability);
    return new Response(result.yaml, { headers: {
      ...headers, 'Content-Type': 'application/yaml; charset=utf-8',
      'X-Proxy-Source-Status': result.stale ? 'stale' : 'fresh'
    } });
  } catch (error) {
    const response = jsonError(error);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}
