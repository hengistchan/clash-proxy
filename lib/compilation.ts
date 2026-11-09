import type Database from 'better-sqlite3';
import type { Snapshot } from './types';
import { configTargetIds, type ConfigTarget } from './config-targets';
import { refreshStashConfig, stashCompiledRevision } from './stash-compilation';
import { refreshShadowrocketConfig, shadowrocketCompiledRevision } from './shadowrocket-compilation';

import { refreshMihomoConfig, mihomoCompiledRevision } from './mihomo-compilation';

interface CompileAdapter {
  refresh(db: Database.Database, snapshot: Snapshot): void;
  protectedRevision(db: Database.Database, profileId: number): number | null;
}

const compilers = {
  stash: { refresh: refreshStashConfig, protectedRevision: stashCompiledRevision },
  shadowrocket: { refresh: refreshShadowrocketConfig, protectedRevision: shadowrocketCompiledRevision },
  mihomo: { refresh: refreshMihomoConfig, protectedRevision: mihomoCompiledRevision }
} satisfies Record<ConfigTarget, CompileAdapter>;

/** Each adapter owns its validation and publishes only a successful artifact. */
export function refreshCompiledConfig(db: Database.Database, snapshot: Snapshot) {
  for (const target of configTargetIds) compilers[target].refresh(db, snapshot);
}

export function protectedCompiledRevisions(db: Database.Database, profileId: number) {
  return configTargetIds.map((target) => compilers[target].protectedRevision(db, profileId))
    .filter((revision): revision is number => revision !== null);
}
