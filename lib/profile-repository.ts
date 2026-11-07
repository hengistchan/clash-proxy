import type Database from 'better-sqlite3';

import { getDb, transaction } from './db';
import { encryptJson } from './crypto';
import { HttpError } from './http';
import { parseYamlDocument } from './yaml-import';
import type {
  JsonObject,
  LogLevel,
  Profile,
  ProfileMode,
  Snapshot
} from './types';
import {
  assertProfileNameAvailable,
  getProfileRow,
  mapProfile,
  now,
  publicSnapshot,
  snapshotFromDb
} from './repository-shared';
import { replaceProfileResources, seedTemplate } from './profile-content';

export function createProfileRepository({
  ensureInitialized,
  recordRevision
}: {
  ensureInitialized: () => void;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
  function listProfiles(): Profile[] {
    ensureInitialized();
    return getDb()
      .prepare('SELECT * FROM profiles ORDER BY active DESC, id')
      .all()
      .map((row) => mapProfile(row as Record<string, unknown>));
  }

  function getProfile(profileId: number): Profile {
    ensureInitialized();
    return mapProfile(getProfileRow(getDb(), profileId));
  }

  function getActiveProfile(): Profile {
    ensureInitialized();
    const row = getDb()
      .prepare('SELECT * FROM profiles WHERE active = 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      throw new HttpError(503, 'No active configuration profile');
    }
    return mapProfile(row);
  }

  function createProfile(
    name: string,
    yamlText?: string,
    example = false
  ): Snapshot {
    ensureInitialized();
    return transaction((db) => {
      assertProfileNameAvailable(db, name);
      const result = db
        .prepare(
          `INSERT INTO profiles
          (name, mode, log_level, ipv6, settings_ciphertext, active, revision, created_at, updated_at)
         VALUES (?, 'rule', 'silent', NULL, ?, 0, 0, ?, ?)`
        )
        .run(name, encryptJson({ dns: {} }), now(), now());
      const profileId = Number(result.lastInsertRowid);
      const document =
        yamlText || example
          ? parseYamlDocument(yamlText || seedTemplate())
          : {
              mode: 'rule' as const,
              logLevel: 'silent' as const,
              ipv6: null,
              settings: { dns: { nameserver: ['223.5.5.5'] } },
              proxies: [],
              proxyProviders: [],
              proxyGroups: [],
              ruleProviders: [],
              rules: [
                {
                  type: 'MATCH',
                  payload: '',
                  policy: 'DIRECT',
                  options: [],
                  enabled: true,
                  note: ''
                }
              ],
              hosts: [],
              advancedSections: []
            };
      replaceProfileResources(db, profileId, document);
      recordRevision(db, profileId);
      return publicSnapshot(snapshotFromDb(db, profileId));
    });
  }

  function updateProfile(
    profileId: number,
    patch: { name?: string; active?: boolean }
  ): Profile {
    ensureInitialized();
    return transaction((db) => {
      const current = getProfileRow(db, profileId);
      const name = patch.name ?? String(current.name);
      assertProfileNameAvailable(db, name, profileId);
      if (patch.active === false && Boolean(current.active)) {
        throw new HttpError(
          409,
          'Activate another profile instead of leaving no active profile'
        );
      }
      if (patch.active === true) {
        db.prepare('UPDATE profiles SET active = 0 WHERE active = 1').run();
      }
      db.prepare('UPDATE profiles SET name = ?, active = ? WHERE id = ?').run(
        name,
        patch.active === undefined
          ? Number(current.active)
          : Number(patch.active),
        profileId
      );
      recordRevision(db, profileId);
      return mapProfile(getProfileRow(db, profileId));
    });
  }

  function deleteProfile(profileId: number): void {
    ensureInitialized();
    transaction((db) => {
      const profile = getProfileRow(db, profileId);
      if (Boolean(profile.active)) {
        throw new HttpError(409, 'The active profile cannot be deleted');
      }
      db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
    });
  }

  // Server compiler only. Do not serialize this snapshot into management responses.
  function getCompilationSnapshot(profileId: number): Snapshot {
    ensureInitialized();
    const db = getDb();
    return db.transaction(() => snapshotFromDb(db, profileId))();
  }

  function getSnapshot(profileId: number): Snapshot {
    ensureInitialized();
    return publicSnapshot(getCompilationSnapshot(profileId));
  }

  function saveSettings(
    profileId: number,
    input: {
      mode: ProfileMode;
      logLevel: LogLevel;
      ipv6?: boolean | null;
      settings: JsonObject;
      targetPlatform?: Profile['targetPlatform'];
    }
  ): Snapshot {
    ensureInitialized();
    return transaction((db) => {
      getProfileRow(db, profileId);
      db.prepare(
        `UPDATE profiles
       SET mode = ?, log_level = ?, ipv6 = ?, settings_ciphertext = ?, updated_at = ?, target_platform = COALESCE(?, target_platform)
       WHERE id = ?`
      ).run(
        input.mode,
        input.logLevel,
        input.ipv6 === undefined || input.ipv6 === null
          ? null
          : Number(input.ipv6),
        encryptJson(input.settings),
        now(),
        input.targetPlatform ?? null,
        profileId
      );
      recordRevision(db, profileId);
      return publicSnapshot(snapshotFromDb(db, profileId));
    });
  }

  function resourceUsage(profileId: number): Record<string, number> {
    const snapshot = getSnapshot(profileId);
    return {
      proxies: snapshot.proxies.length,
      proxyProviders: snapshot.proxyProviders.length,
      proxyGroups: snapshot.proxyGroups.length,
      ruleProviders: snapshot.ruleProviders.length,
      rules: snapshot.rules.length,
      hosts: snapshot.hosts.length,
      advancedSections: snapshot.advancedSections.length
    };
  }

  return {
    listProfiles,
    getProfile,
    getActiveProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    getCompilationSnapshot,
    getSnapshot,
    saveSettings,
    resourceUsage
  };
}
