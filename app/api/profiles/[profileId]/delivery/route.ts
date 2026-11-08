import { profileDeliveryTargets } from '@/lib/config-delivery-adapters';
import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const profileId = parseId((await context.params).profileId);
    const targets = profileDeliveryTargets(request, profileId);
    return Response.json(
      {
        ...targets.stash,
        shadowrocket: targets.shadowrocket,
        targets
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
