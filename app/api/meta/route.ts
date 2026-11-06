import { NextResponse } from 'next/server';

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
    version: '3.0.0',
    rule_types: RULE_TYPES,
    rule_options: RULE_OPTIONS,
    proxy_group_types: PROXY_GROUP_TYPES,
    builtin_policies: BUILTIN_POLICIES,
    admin_token_required: Boolean(process.env.STASH_ADMIN_TOKEN?.trim())
  });
}
