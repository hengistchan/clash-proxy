import type Database from 'better-sqlite3';
import type { Snapshot, ValidationResult } from './types';
import { validateSnapshot } from './validation';
import { recordOperation } from './telemetry';
import { configTargetIds, type ConfigTarget } from './config-targets';
import { refreshStashConfig, stashCompiledRevision } from './stash-compilation';
import { refreshShadowrocketConfig, shadowrocketCompiledRevision } from './shadowrocket-compilation';

import { refreshMihomoConfig, mihomoCompiledRevision } from './mihomo-compilation';

interface CompileAdapter {
  refresh(db: Database.Database, snapshot: Snapshot, validation?: ValidationResult): void;
  protectedRevision(db: Database.Database, profileId: number): number | null;
}

const compilers = {
  stash: { refresh: refreshStashConfig, protectedRevision: stashCompiledRevision },
  shadowrocket: { refresh: refreshShadowrocketConfig, protectedRevision: shadowrocketCompiledRevision },
  mihomo: { refresh: refreshMihomoConfig, protectedRevision: mihomoCompiledRevision }
} satisfies Record<ConfigTarget, CompileAdapter>;

/** Each adapter owns its validation and publishes only a successful artifact. */
export function refreshCompiledConfig(db: Database.Database, snapshot: Snapshot) {
  const validation = validateSnapshot(snapshot);
  for (const target of configTargetIds) {
    const started = performance.now();
    let success = false;
    try { compilers[target].refresh(db, snapshot, validation); success = compilers[target].protectedRevision(db, snapshot.profile.id) === snapshot.profile.revision; }
    finally { recordOperation(`compile.${target}`, performance.now() - started, success); }
  }
}

export function protectedCompiledRevisions(db: Database.Database, profileId: number) {
  return configTargetIds.map((target) => compilers[target].protectedRevision(db, profileId))
    .filter((revision): revision is number => revision !== null);
}
