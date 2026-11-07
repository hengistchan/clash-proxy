import type Database from 'better-sqlite3';

import { transaction } from './db';
import { encryptJson } from './crypto';
import { HttpError } from './http';
import type { AdvancedSection, JsonValue } from './types';
import { RESERVED_TOP_LEVEL_KEYS } from './types';
import { getProfileRow, snapshotFromDb } from './repository-shared';

export function createAdvancedRepository({
  ensureInitialized,
  recordRevision
}: {
  ensureInitialized: () => void;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
  function replaceAdvancedSections(
    profileId: number,
    sections: Array<{ key: string; value: JsonValue }>
  ): AdvancedSection[] {
    ensureInitialized();
    return transaction((db) => {
      getProfileRow(db, profileId);
      const seen = new Set<string>();
      for (const section of sections) {
        if (RESERVED_TOP_LEVEL_KEYS.has(section.key)) {
          throw new HttpError(
            400,
            `Top-level section “${section.key}” is managed by a dedicated resource`
          );
        }
        if (seen.has(section.key)) {
          throw new HttpError(400, `Duplicate advanced section: ${section.key}`);
        }
        seen.add(section.key);
      }
      db.prepare('DELETE FROM advanced_sections WHERE profile_id = ?').run(
        profileId
      );
      const insert = db.prepare(
        `INSERT INTO advanced_sections
         (profile_id, section_key, value_ciphertext, sort_order)
       VALUES (?, ?, ?, ?)`
      );
      sections.forEach((section, index) => {
        insert.run(profileId, section.key, encryptJson(section.value), index + 1);
      });
      recordRevision(db, profileId);
      return snapshotFromDb(db, profileId).advancedSections;
    });
  }

  return { replaceAdvancedSections };
}
