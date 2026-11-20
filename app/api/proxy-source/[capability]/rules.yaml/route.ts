import { jsonError } from '@/lib/http';
import { mirroredRuleSource } from '@/lib/public-rule-mirror';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ capability: string }> }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  try {
    const text = await mirroredRuleSource((await context.params).capability);
    return new Response(text, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (error) {
    const response = jsonError(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}
