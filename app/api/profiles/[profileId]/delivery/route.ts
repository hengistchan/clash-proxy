import { deliveryLinks } from '@/lib/download-response';
import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

import { getDeliveryStatus } from '@/lib/delivery';
export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const profileId = parseId((await context.params).profileId);
    return Response.json(
      deliveryLinks(request, profileId, getDeliveryStatus(profileId)),
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
