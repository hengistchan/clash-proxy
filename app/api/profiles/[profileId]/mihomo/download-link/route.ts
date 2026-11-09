import { configTargetHandlers } from '@/lib/config-delivery-adapters';

export const runtime = 'nodejs';
const handlers = configTargetHandlers('mihomo');
export const POST = handlers.rotate;
export const DELETE = handlers.revoke;
