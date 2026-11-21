import { requireAdmin } from '@/lib/auth';
import { jsonError } from '@/lib/http';
import { operationMetrics } from '@/lib/telemetry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    requireAdmin(request);
    return Response.json(operationMetrics(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
