import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { previewImport } from '@/lib/revision-comparison';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ profileId: string }> }) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = z.object({ yaml: z.string().min(1) }).parse(await readJson(request));
    return Response.json(previewImport(parseId(profileId), input.yaml), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
