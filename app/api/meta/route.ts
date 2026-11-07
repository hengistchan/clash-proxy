import { NextResponse } from 'next/server';
import { adminAuthenticationRequired } from '@/Scripts/runtime-security.mjs';
import { SERVICE_VERSION } from '@/lib/version';

import {
  PROXY_GROUP_TYPES,
  RULE_OPTIONS,
  RULE_TYPES,
  BUILTIN_POLICIES
} from '@/lib/types';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({
    service: 'stash-config-forge',
    version: SERVICE_VERSION,
    rule_types: RULE_TYPES,
    rule_options: RULE_OPTIONS,
    proxy_group_types: PROXY_GROUP_TYPES,
    builtin_policies: BUILTIN_POLICIES,
    admin_token_required: adminAuthenticationRequired()
  });
}
