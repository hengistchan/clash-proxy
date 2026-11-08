import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { classifyConfig } from '@/lib/config-import';
import { jsonError, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAdmin(request);
    const { content } = z.object({ content: z.string().min(1) }).parse(await readJson(request));
    return Response.json(classifyConfig(content), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
