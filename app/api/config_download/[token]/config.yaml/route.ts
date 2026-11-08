import { configTargetHandlers } from '@/lib/config-delivery-adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = configTargetHandlers('stash').deviceDownload;
