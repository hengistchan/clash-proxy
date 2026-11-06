import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { getSnapshot } from '@/lib/repository';
import { buildResourceGraph } from '@/lib/resource-graph';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ profileId: string }> }
) {
  try {
    requireAdmin(request);
    return Response.json(
      buildResourceGraph(getSnapshot(parseId((await context.params).profileId)))
    );
  } catch (error) {
    return jsonError(error);
  }
}
