import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth';
import { jsonError, parseId, readJson } from '@/lib/http';
import { getSnapshot, saveSettings } from '@/lib/repository';
import { settingsSchema } from '@/lib/schemas';
import { validateSnapshot } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ profileId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const snapshot = getSnapshot(parseId(profileId));
    return NextResponse.json({
      mode: snapshot.profile.mode,
      logLevel: snapshot.profile.logLevel,
      ipv6: snapshot.profile.ipv6,
      settings: snapshot.profile.settings
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    requireAdmin(request);
    const { profileId } = await context.params;
    const input = settingsSchema.parse(await readJson(request));
    const snapshot = saveSettings(parseId(profileId), input);
    return NextResponse.json({
      mode: snapshot.profile.mode,
      logLevel: snapshot.profile.logLevel,
      ipv6: snapshot.profile.ipv6,
      settings: snapshot.profile.settings,
      validation: validateSnapshot(snapshot)
    });
  } catch (error) {
    return jsonError(error);
  }
}
