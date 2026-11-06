import { requireAdmin } from '@/lib/auth';
import { exportProfile } from '@/lib/exporter';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getSnapshot } from '@/lib/repository';
import { exportSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string }> };

function response(result: ReturnType<typeof exportProfile>) {
  return new Response(result.yaml, {
    headers: {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Config-SHA256': result.sha256,
      'X-Rule-Count': String(result.ruleCount),
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const url = new URL(request.url);
    const input = exportSchema.parse({
      url: url.searchParams.get('url') || '',
      template: url.searchParams.get('template') || 'production'
    });
    return response(
      exportProfile(getSnapshot(parseId(profileId)), {
        subscriptionUrl: input.url,
        template: input.template
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = exportSchema.parse(await readJson(request));
    return response(
      exportProfile(getSnapshot(parseId(profileId)), {
        subscriptionUrl: input.url,
        template: input.template
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}
