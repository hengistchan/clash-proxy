import { NextResponse } from 'next/server';

import { getActiveProfile } from '@/lib/repository';
import { SERVICE_VERSION } from '@/lib/version';
import { assertRuntimeSecurity } from '@/Scripts/runtime-security.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertRuntimeSecurity(process.env);
    getActiveProfile();
    return NextResponse.json({
      status: 'ok',
      service: 'stash-config-forge',
      version: SERVICE_VERSION
    });
  } catch {
    return NextResponse.json(
      { status: 'error', service: 'stash-config-forge' },
      { status: 503 }
    );
  }
}
