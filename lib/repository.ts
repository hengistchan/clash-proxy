import { createRuleRepository } from './rule-repository';
import { persistRevision } from './revision-store';
import { getDb } from './db';
import { encryptJson } from './crypto';
import { parseYamlDocument } from './yaml-import';
import { snapshotFromDb } from './repository-shared';
import { replaceProfileResources, seedTemplate } from './profile-content';
import { createProxyRepository } from './proxy-repository';
import { createRuleProviderRepository } from './rule-provider-repository';
import { createHostRepository } from './host-repository';
import { createAdvancedRepository } from './advanced-repository';
import { createProfileRepository } from './profile-repository';
import { createRevisionRepository } from './revision-repository';

type DbRow = Record<string, unknown>;

export function recordRevision(
  db: Parameters<typeof persistRevision>[0],
  profileId: number
): number {
  return persistRevision(db, profileId, () => snapshotFromDb(db, profileId));
}

let initialized = false;

export function ensureInitialized(): void {
  if (initialized) return;
  const db = getDb();
  const existing = db
    .prepare('SELECT COUNT(*) AS total FROM profiles')
    .get() as DbRow;
  if (Number(existing.total) > 0) {
    initialized = true;
    return;
  }
  const initialize = db.transaction(() => {
    const tx = db;
    const count = tx
      .prepare('SELECT COUNT(*) AS total FROM profiles')
      .get() as DbRow;
    if (Number(count.total) > 0) return;
    const created = tx
      .prepare(
        `INSERT INTO profiles
          (name, mode, log_level, ipv6, settings_ciphertext, active, revision, created_at, updated_at)
         VALUES (?, 'rule', 'info', NULL, ?, 1, 0, ?, ?)`
      )
      .run(
        process.env.STASH_SEED_EXAMPLE === '1' ? '示例配置' : '我的配置',
        encryptJson({ dns: {} }),
        new Date().toISOString(),
        new Date().toISOString()
      );
    const profileId = Number(created.lastInsertRowid);
    const document = parseYamlDocument(
      process.env.STASH_SEED_EXAMPLE === '1'
        ? seedTemplate()
        : 'mode: rule\nrules: ["MATCH,DIRECT"]\n'
    );
    replaceProfileResources(tx, profileId, document);
    recordRevision(tx, profileId);
  });
  initialize.immediate();
  initialized = true;
}

export function resetRepositoryForTests(): void {
  initialized = false;
}

// The public repository remains a facade; each resource module owns one
// bounded part of the read/write model.
const ruleRepository = createRuleRepository({
  ensureInitialized,
  snapshotFromDb,
  recordRevision
});
const proxyRepository = createProxyRepository({
  ensureInitialized,
  recordRevision
});
const ruleProviderRepository = createRuleProviderRepository({
  ensureInitialized,
  recordRevision
});
const hostRepository = createHostRepository({
  ensureInitialized,
  recordRevision
});
const advancedRepository = createAdvancedRepository({
  ensureInitialized,
  recordRevision
});
const profileRepository = createProfileRepository({
  ensureInitialized,
  recordRevision
});
const revisionRepository = createRevisionRepository({
  ensureInitialized,
  recordRevision
});

export const { createRule, updateRule, deleteRule, reorderRules } =
  ruleRepository;
export const {
  createProxy,
  updateProxy,
  deleteProxy,
  createProxyProvider,
  updateProxyProvider,
  deleteProxyProvider,
  createProxyGroup,
  updateProxyGroup,
  deleteProxyGroup
} = proxyRepository;
export const {
  createRuleProvider,
  updateRuleProvider,
  deleteRuleProvider,
  createRuleProviderEntry,
  updateRuleProviderEntry,
  deleteRuleProviderEntry
} = ruleProviderRepository;
export const { createHost, updateHost, deleteHost } = hostRepository;
export const { replaceAdvancedSections } = advancedRepository;
export const {
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
} = profileRepository;
export const { importYaml, listRevisions, restoreRevision } = revisionRepository;

export { publicProvider } from './repository-shared';
