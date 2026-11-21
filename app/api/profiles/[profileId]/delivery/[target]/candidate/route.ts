import { previewCandidateConfig } from '@/lib/config-delivery-adapters';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ profileId: string; target: string }> }) {
  return previewCandidateConfig(request, await context.params);
}
