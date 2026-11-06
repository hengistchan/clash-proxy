import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { databasePath } from './crypto';

let connection: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'rule',
  log_level TEXT NOT NULL DEFAULT 'silent',
  ipv6 INTEGER,
  settings_ciphertext TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_active
  ON profiles(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_ciphertext TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE IF NOT EXISTS proxy_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_ciphertext TEXT NOT NULL,
  requires_url INTEGER NOT NULL DEFAULT 0 CHECK (requires_url IN (0, 1)),
  sort_order INTEGER NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE IF NOT EXISTS proxy_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_ciphertext TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(profile_id, name)
);
CREATE INDEX IF NOT EXISTS proxy_groups_order
  ON proxy_groups(profile_id, sort_order);

CREATE TABLE IF NOT EXISTS rule_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  behavior TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_ciphertext TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE IF NOT EXISTS rule_provider_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES rule_providers(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rule_provider_entries_order
  ON rule_provider_entries(provider_id, sort_order);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL CHECK (priority > 0),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(profile_id, priority)
);
CREATE INDEX IF NOT EXISTS rules_priority ON rules(profile_id, priority);

CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(profile_id, pattern)
);

CREATE TABLE IF NOT EXISTS advanced_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  value_ciphertext TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(profile_id, section_key)
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  config_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, revision)
);

PRAGMA user_version = 1;
`;

export function getDb(): Database.Database {
  if (connection) {
    return connection;
  }

  process.umask(0o077);
  const file = databasePath();
  mkdirSync(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true, mode: 0o700 });
  connection = new Database(/*turbopackIgnore: true*/ file);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  connection.pragma('synchronous = NORMAL');
  connection.exec(SCHEMA);
  chmodSync(/*turbopackIgnore: true*/ file, 0o600);
  return connection;
}

export function transaction<T>(operation: (db: Database.Database) => T): T {
  const db = getDb();
  const run = db.transaction(operation);
  return run(db);
}

export function closeDbForTests(): void {
  if (!connection) {
    return;
  }
  connection.close();
  connection = null;
}
