import { exportProfile } from '@/lib/exporter';
import { jsonError, readJson } from '@/lib/http';
import { getActiveProfile, getSnapshot } from '@/lib/repository';
import { exportSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function yamlResponse(result: ReturnType<typeof exportProfile>) {
  return new Response(result.yaml, {
    status: 200,
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const options = exportSchema.parse({
      url: url.searchParams.get('url') || '',
      template: url.searchParams.get('template') || 'production'
    });
    const active = getActiveProfile();
    return yamlResponse(
      exportProfile(getSnapshot(active.id), {
        subscriptionUrl: options.url,
        template: options.template
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const options = exportSchema.parse(await readJson(request));
    const active = getActiveProfile();
    return yamlResponse(
      exportProfile(getSnapshot(active.id), {
        subscriptionUrl: options.url,
        template: options.template
      })
    );
  } catch (error) {
    return jsonError(error);
  }
}
