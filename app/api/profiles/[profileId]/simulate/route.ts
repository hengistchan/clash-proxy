import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ profileId: string }> };

import { readJson } from '@/lib/http';
import { getCompilationSnapshot } from '@/lib/repository';
import { checkedRoutingSnapshot } from '@/lib/checked-rule-sources';
import { simulateRouting } from '@/lib/routing-analysis';
import { z } from 'zod';
import { isIP } from 'node:net';
const input = z.object({
  useCheckedSources: z.boolean().optional(),
  host: z.string().max(253).optional(),
  ip: z
    .string()
    .max(128)
    .refine((value) => isIP(value) > 0, '请输入有效的 IPv4 或 IPv6 地址')
    .optional(),
  network: z.enum(['tcp', 'udp']).optional(),
  protocol: z.string().max(32).optional(),
  process: z.string().max(1024).optional(),
  port: z.number().int().min(1).max(65535).optional()
});
export async function POST(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const options = input.parse(await readJson(request));
    const snapshot = getCompilationSnapshot(parseId((await context.params).profileId));
    const checked = options.useCheckedSources ? checkedRoutingSnapshot(snapshot) : { snapshot, sourceSnapshots: [] };
    return Response.json(
      { ...simulateRouting(checked.snapshot, options), sourceSnapshots: checked.sourceSnapshots }
    );
  } catch (error) {
    return jsonError(error);
  }
}
