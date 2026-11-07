import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
import { compareRevision } from '@/lib/revision-comparison';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ profileId: string; revision: string }> }) {
  try {
    requireAdmin(request);
    const { profileId, revision } = await context.params;
    return Response.json(compareRevision(parseId(profileId), parseId(revision)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
