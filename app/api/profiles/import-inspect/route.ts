import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { inspectNewImport } from '@/lib/revision-comparison';
import { jsonError, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAdmin(request);
    const { content } = z.object({ content: z.string().min(1) }).parse(await readJson(request));
    return Response.json(inspectNewImport(content), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
