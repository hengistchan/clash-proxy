import type Database from 'better-sqlite3';

import { getDb, transaction } from './db';
import { decryptRevision } from './config-storage-model';
import { HttpError } from './http';
import { parseConfigDocument } from './config-import';
import type { Snapshot } from './types';
import { revisionRetentionStatus } from './history-retention';
import {
  getProfileRow,
  publicSnapshot,
  snapshotFromDb
} from './repository-shared';
import { replaceProfileResources } from './profile-content';

export function createRevisionRepository({
  ensureInitialized,
  recordRevision
}: {
  ensureInitialized: () => void;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
  function importYaml(profileId: number, yamlText: string, previewFingerprint?: string): Snapshot {
    ensureInitialized();
    const document = parseConfigDocument(yamlText);
    return transaction((db) => {
      replaceProfileResources(db, profileId, document, 'replace', previewFingerprint);
      recordRevision(db, profileId);
      return publicSnapshot(snapshotFromDb(db, profileId));
    });
  }

  function listRevisions(
    profileId: number,
    options: { limit?: number; before?: number } = {}
  ): {
    items: Array<{ id: number; revision: number; createdAt: string }>;
    nextCursor: number | null;
    retentionLimit: number;
    retainedCount: number;
    oldestRevision: number | null;
  } {
    ensureInitialized();
    getProfileRow(getDb(), profileId);
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    const before = options.before ?? null;
    const rows =
      before === null
        ? (getDb()
            .prepare(
              `SELECT id, revision, created_at
           FROM revisions WHERE profile_id = ?
           ORDER BY revision DESC LIMIT ?`
            )
            .all(profileId, limit + 1) as Record<string, unknown>[])
        : (getDb()
            .prepare(
              `SELECT id, revision, created_at
           FROM revisions WHERE profile_id = ? AND revision < ?
           ORDER BY revision DESC LIMIT ?`
            )
            .all(profileId, before, limit + 1) as Record<string, unknown>[]);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
      const item = row as Record<string, unknown>;
      return {
        id: Number(item.id),
        revision: Number(item.revision),
        createdAt: String(item.created_at)
      };
    });
    return {
      ...revisionRetentionStatus(getDb(), profileId),
      items,
      nextCursor: hasMore ? (items.at(-1)?.revision ?? null) : null
    };
  }

  function restoreRevision(profileId: number, revision: number): Snapshot {
    ensureInitialized();
    return transaction((db) => {
      const row = db
        .prepare(
          'SELECT config_ciphertext FROM revisions WHERE profile_id = ? AND revision = ?'
        )
        .get(profileId, revision) as Record<string, unknown> | undefined;
      if (!row) throw new HttpError(404, 'Revision not found');
      const snapshot = decryptRevision(String(row.config_ciphertext));
      replaceProfileResources(db, profileId, {
        mode: snapshot.profile.mode,
        targetPlatform: snapshot.profile.targetPlatform,
        logLevel: snapshot.profile.logLevel,
        ipv6: snapshot.profile.ipv6,
        settings: snapshot.profile.settings,
        clientOptions: snapshot.profile.clientOptions,
        proxies: snapshot.proxies.map((item) => ({
          name: item.name,
          type: item.type,
          config: item.config
        })),
        proxyProviders: snapshot.proxyProviders.map((item) => ({
          name: item.name,
          config: item.config,
          requiresUrl: item.requiresUrl,
          rewriteRules: item.rewriteRules,
          previousId: item.id
        })),
        proxyGroups: snapshot.proxyGroups.map((item) => ({
          clientOptions: item.clientOptions,
          name: item.name,
          type: item.type,
          config: item.config
        })),
        ruleProviders: snapshot.ruleProviders.map((item) => ({
          clientOptions: item.clientOptions,
          name: item.name,
          displayName: item.displayName,
          behavior: item.behavior,
          providerType: item.providerType,
          config: item.config,
          entries: item.entries.map((entry) => entry.value)
        })),
        rules: snapshot.rules.map((item) => ({
          type: item.type,
          payload: item.payload,
          policy: item.policy,
          options: item.options,
          enabled: item.enabled,
          note: item.note
        })),
        hosts: snapshot.hosts.map((item) => ({
          pattern: item.pattern,
          value: item.value
        })),
        advancedSections: snapshot.advancedSections.map((item) => ({
          key: item.key,
          value: item.value
        }))
      }, 'restore');
      recordRevision(db, profileId);
      return publicSnapshot(snapshotFromDb(db, profileId));
    });
  }

  return { importYaml, listRevisions, restoreRevision };
}
