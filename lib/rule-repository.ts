import type Database from 'better-sqlite3';
import { transaction } from './db';
import { HttpError } from './http';
import { projectMatchType, storeMatchType } from './config-storage-model';
import { normalizeRuleInput } from './rules';
import type { Snapshot, StashRule } from './types';
type DbRow = Record<string, unknown>;

export function mapRule(row: DbRow): StashRule {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(String(row.options_json || '[]'));
    options = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    options = [];
  }
  return {
    id: Number(row.id),
    priority: Number(row.priority),
    type: projectMatchType(String(row.type)),
    payload: String(row.payload || ''),
    policy: String(row.policy),
    options,
    enabled: Boolean(row.enabled),
    note: String(row.note || '')
  };
}


export function createRuleRepository({ ensureInitialized, snapshotFromDb, recordRevision }: {
  ensureInitialized: () => void;
  snapshotFromDb: (db: Database.Database, profileId: number) => Snapshot;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
function terminalRule(rules: StashRule[], required = true): StashRule | null {
  const enabled = rules.filter((rule) => rule.enabled);
  const terminal = enabled.at(-1);
  const matches = rules.filter((rule) => rule.type === 'MATCH');
  if (!required && matches.length === 0) return null;
  if (matches.length !== 1 || !terminal || terminal.type !== 'MATCH') {
    throw new HttpError(409, 'Exactly one enabled MATCH rule must remain last');
  }
  return terminal;
}

function renumberRules(
  db: Database.Database,
  profileId: number,
  ids: number[]
): void {
  db.prepare(
    'UPDATE rules SET priority = priority + 1000000 WHERE profile_id = ?'
  ).run(profileId);
  ids.forEach((id, index) => {
    db.prepare(
      'UPDATE rules SET priority = ? WHERE id = ? AND profile_id = ?'
    ).run(index + 1, id, profileId);
  });
}

function createRule(
  profileId: number,
  input: {
    type: string;
    payload?: string;
    policy: string;
    options?: string[];
    enabled?: boolean;
    note?: string;
    priority?: number;
  }
): StashRule {
  ensureInitialized();
  return transaction((db) => {
    const current = snapshotFromDb(db, profileId);
    const rule = normalizeRuleInput(input);
    const matches = current.rules.filter((item) => item.type === 'MATCH');
    if (rule.type === 'MATCH' && matches.length) {
      throw new HttpError(409, 'A terminal MATCH rule already exists');
    }
    if (rule.type === 'MATCH' && !rule.enabled) {
      throw new HttpError(409, 'The terminal MATCH rule must remain enabled');
    }
    // A structurally valid import can be an invalid draft. Let users add its
    // missing terminal rule without first requiring that rule to already exist.
    const terminal = rule.type === 'MATCH'
      ? null
      : terminalRule(current.rules, current.profile.mode === 'rule');
    const ids = current.rules
      .map((item) => item.id)
      .filter((id) => id !== terminal?.id);
    const order = db
      .prepare(
        `INSERT INTO rules
        (profile_id, priority, type, payload, policy, options_json, enabled, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        current.rules.length + 1,
        storeMatchType(rule.type),
        rule.payload,
        rule.policy,
        JSON.stringify(rule.options),
        Number(rule.enabled),
        rule.note
      );
    const id = Number(order.lastInsertRowid);
    const insertAt = Math.max(
      0,
      Math.min((input.priority || terminal?.priority || ids.length + 1) - 1, ids.length)
    );
    if (rule.type === 'MATCH') ids.push(id);
    else ids.splice(insertAt, 0, id);
    if (terminal) ids.push(terminal.id);
    renumberRules(db, profileId, ids);
    recordRevision(db, profileId);
    return mapRule(
      db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as DbRow
    );
  });
}

function updateRule(
  profileId: number,
  itemId: number,
  input: {
    type: string;
    payload?: string;
    policy: string;
    options?: string[];
    enabled?: boolean;
    note?: string;
    priority?: number;
  }
): StashRule {
  ensureInitialized();
  return transaction((db) => {
    const currentRow = db
      .prepare('SELECT * FROM rules WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!currentRow) throw new HttpError(404, 'Rule not found');
    const currentSnapshot = snapshotFromDb(db, profileId);
    const rule = normalizeRuleInput(input);
    const existing = currentSnapshot.rules.find((item) => item.id === itemId);
    if (!existing) throw new HttpError(404, 'Rule not found');
    const matches = currentSnapshot.rules.filter((item) => item.type === 'MATCH');
    const protectedTerminal = matches.length === 1 && existing.type === 'MATCH' &&
      existing.enabled && currentSnapshot.rules.filter((item) => item.enabled).at(-1)?.id === existing.id;
    if (existing.type === 'MATCH') {
      if (rule.type !== 'MATCH' || !rule.enabled) {
        throw new HttpError(
          409,
          'The terminal MATCH rule cannot be converted or disabled'
        );
      }
      if (protectedTerminal && input.priority && input.priority !== existing.priority) {
        throw new HttpError(409, 'The terminal MATCH rule must remain last');
      }
    } else if (rule.type === 'MATCH' && matches.length) {
      throw new HttpError(409, 'A terminal MATCH rule already exists');
    }
    if (rule.type === 'MATCH' && !rule.enabled) {
      throw new HttpError(409, 'The terminal MATCH rule must remain enabled');
    }
    // Saving an existing misplaced/disabled MATCH repairs it by placing the
    // enabled rule last. Converting the first MATCH follows the same path.
    const terminal = rule.type === 'MATCH'
      ? null
      : terminalRule(currentSnapshot.rules, currentSnapshot.profile.mode === 'rule');
    db.prepare(
      `UPDATE rules
       SET type = ?, payload = ?, policy = ?, options_json = ?, enabled = ?, note = ?
       WHERE id = ?`
    ).run(
      storeMatchType(rule.type),
      rule.payload,
      rule.policy,
      JSON.stringify(rule.options),
      Number(rule.enabled),
      rule.note,
      itemId
    );
    if ((input.priority && existing.type !== 'MATCH') || (rule.type === 'MATCH' && !protectedTerminal)) {
      const ids = currentSnapshot.rules
        .map((item) => item.id)
        .filter((id) => id !== itemId && id !== terminal?.id);
      const insertAt = Math.max(0, Math.min((input.priority || ids.length + 1) - 1, ids.length));
      if (rule.type === 'MATCH') ids.push(itemId);
      else ids.splice(insertAt, 0, itemId);
      if (terminal) ids.push(terminal.id);
      renumberRules(db, profileId, ids);
    }
    recordRevision(db, profileId);
    return mapRule(
      db.prepare('SELECT * FROM rules WHERE id = ?').get(itemId) as DbRow
    );
  });
}

function deleteRule(profileId: number, itemId: number): void {
  ensureInitialized();
  transaction((db) => {
    const row = db
      .prepare('SELECT * FROM rules WHERE id = ? AND profile_id = ?')
      .get(itemId, profileId) as DbRow | undefined;
    if (!row) throw new HttpError(404, 'Rule not found');
    if (mapRule(row).type === 'MATCH') {
      const rules = snapshotFromDb(db, profileId).rules;
      const matches = rules.filter((rule) => rule.type === 'MATCH');
      const lastEnabled = rules.filter((rule) => rule.enabled).at(-1);
      if (matches.length <= 1 || lastEnabled?.id === itemId) {
        throw new HttpError(409, 'The terminal MATCH rule cannot be deleted');
      }
    }
    db.prepare('DELETE FROM rules WHERE id = ?').run(itemId);
    const ids = (
      db
        .prepare(
          'SELECT id FROM rules WHERE profile_id = ? ORDER BY priority, id'
        )
        .all(profileId) as DbRow[]
    ).map((item) => Number(item.id));
    renumberRules(db, profileId, ids);
    recordRevision(db, profileId);
  });
}

function reorderRules(profileId: number, ids: number[]): StashRule[] {
  ensureInitialized();
  return transaction((db) => {
    const snapshot = snapshotFromDb(db, profileId);
    const terminal = terminalRule(snapshot.rules, snapshot.profile.mode === 'rule');
    const currentIds = snapshot.rules.map((rule) => rule.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== currentIds.length ||
      ids.some((id) => !currentIds.includes(id)) ||
      (terminal !== null && ids.at(-1) !== terminal.id)
    ) {
      throw new HttpError(
        409,
        'Order must include every rule once and end with MATCH'
      );
    }
    renumberRules(db, profileId, ids);
    recordRevision(db, profileId);
    return snapshotFromDb(db, profileId).rules;
  });
}

  return { createRule, updateRule, deleteRule, reorderRules };
}
