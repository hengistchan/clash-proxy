import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { withProfileRevision } from '@/lib/revision-control';
import { batchUpdateRules, ruleBatchSchema } from '@/lib/rule-batch';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PUT(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    requireAdmin(request);
    const id = parseId((await context.params).profileId);
    const input = ruleBatchSchema.parse(await readJson(request));
    return withProfileRevision(request, id, () => Response.json(batchUpdateRules(id, input)));
  } catch (error) { return jsonError(error); }
}
