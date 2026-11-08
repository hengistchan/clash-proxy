import { configTargetHandlers } from '@/lib/config-delivery-adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const handlers = configTargetHandlers('stash');
export const POST = handlers.rotate;
export const DELETE = handlers.revoke;
