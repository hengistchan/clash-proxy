import { NextResponse } from 'next/server';

import { getActiveProfile } from '@/lib/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    getActiveProfile();
    return NextResponse.json({
      status: 'ok',
      service: 'stash-config-forge',
      version: '3.0.0'
    });
  } catch {
    return NextResponse.json(
      { status: 'error', service: 'stash-config-forge' },
      { status: 503 }
    );
  }
}
