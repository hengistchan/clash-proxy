import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, readJson } from '@/lib/http';
import { createProfile, listProfiles } from '@/lib/repository';
import { profileCreateSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    requireAdmin(request);
    return NextResponse.json({ items: listProfiles() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireAdmin(request);
    const input = profileCreateSchema.parse(await readJson(request));
    const snapshot = createProfile(input.name, input.importYaml);
    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
