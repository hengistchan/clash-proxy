import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { shadowrocketDeliveryLinks } from '@/lib/download-response';
import { revokeShadowrocketLink, rotateShadowrocketLink } from '@/lib/shadowrocket-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const profileId = parseId((await context.params).profileId);
    return Response.json(shadowrocketDeliveryLinks(request, profileId, await rotateShadowrocketLink(profileId)), {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    revokeShadowrocketLink(parseId((await context.params).profileId));
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
