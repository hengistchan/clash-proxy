import { deliveryLinks } from '@/lib/download-response';
import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

import { rotateDownloadLink, revokeDownloadLink } from '@/lib/delivery';
export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const profileId = parseId((await context.params).profileId);
    return Response.json(
      deliveryLinks(request, profileId, rotateDownloadLink(profileId)),
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    requireAdmin(request);
    revokeDownloadLink(parseId((await context.params).profileId));
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
