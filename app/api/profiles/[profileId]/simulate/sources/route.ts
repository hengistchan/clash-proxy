import { requireAdmin } from '@/lib/auth';
import { checkRoutingSources } from '@/lib/checked-rule-sources';
import { jsonError, parseId } from '@/lib/http';
import { getCompilationSnapshot } from '@/lib/repository';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    requireAdmin(request);
    return Response.json(await checkRoutingSources(getCompilationSnapshot(parseId((await context.params).profileId))), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
