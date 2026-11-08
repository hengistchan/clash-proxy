import { previewDeliveredConfig } from '@/lib/config-delivery-adapters';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ profileId: string; target: string }> }
) {
  return previewDeliveredConfig(request, await context.params);
}
