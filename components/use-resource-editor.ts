'use client';

import { useState } from 'react';
import type { Snapshot, ResourceKind } from '@/lib/types';
import type { EditorPreset } from './relationships-view';

export type EditableResource = Snapshot['proxies'][number] | Snapshot['proxyProviders'][number] |
  Snapshot['proxyGroups'][number] | Snapshot['ruleProviders'][number] | Snapshot['rules'][number] | Snapshot['hosts'][number] | null;

export function useResourceEditor() {
  const [session, setSession] = useState<{ kind: ResourceKind; item: EditableResource; preset?: EditorPreset } | null>(null);
  return {
    session,
    open: (kind: ResourceKind, item: EditableResource = null, preset?: EditorPreset) => setSession({ kind, item, preset }),
    close: () => setSession(null)
  };
}
