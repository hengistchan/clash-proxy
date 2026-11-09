import { classifyConfig, parseConfigDocument } from './config-import';
import { getDb } from './db';
import { decryptRevision } from './config-storage-model';
import { HttpError } from './http';
import { compareConfigurations } from './config-diff';
import { ensureInitialized, getCompilationSnapshot } from './repository';
import { importedSnapshot, importPreviewFingerprint, prepareImport } from './import-candidate';
import { checkDraft } from './draft-check';
import { servedRecord } from './target-publication-store';

export const NORMALIZATION_NOTICE = '导入会分类保存共有语义和客户端专用字段；注释及原始排版不会保留。下面只展示语义变化摘要，不显示私人连接参数或凭据。';

export function compareRevision(profileId: number, targetRevision: number) {
  // Initialize before opening a consistent read transaction.
  getCompilationSnapshot(profileId);
  return getDb().transaction(() => {
    const current = getCompilationSnapshot(profileId);
    const row = getDb().prepare('SELECT config_ciphertext FROM revisions WHERE profile_id = ? AND revision = ?').get(profileId, targetRevision) as { config_ciphertext: string } | undefined;
    if (!row) throw new HttpError(404, 'Revision not found or no longer retained');
    const target = decryptRevision(row.config_ciphertext);
    return { baseRevision: current.profile.revision, currentRevision: current.profile.revision, targetRevision, changes: compareConfigurations(current, target) };
  })();
}

export function previewImport(profileId: number, text: string) {
  const document = parseConfigDocument(text);
  const classification = classifyConfig(text, document);
  // Initialize outside the read transaction, then read a single consistent revision.
  ensureInitialized();
  const db = getDb();
  return db.transaction(() => {
    const before = getCompilationSnapshot(profileId);
    const prepared = prepareImport(db, profileId, document, before, 'replace');
    const after = importedSnapshot(before.profile, prepared);
    return {
      currentRevision: before.profile.revision,
      changes: compareConfigurations(before, after),
      normalizationNotice: NORMALIZATION_NOTICE,
      classification,
      previewFingerprint: importPreviewFingerprint(before.profile, prepared),
      checks: checkDraft(after, {
        stash: servedRecord(db, profileId, 'stash')?.revision,
        shadowrocket: servedRecord(db, profileId, 'shadowrocket')?.revision,
        mihomo: servedRecord(db, profileId, 'mihomo')?.revision
      })
    };
  })();
}

export function inspectNewImport(text: string) {
  const document = parseConfigDocument(text);
  const base = {
    id: 0, name: '', mode: 'rule', logLevel: 'silent', ipv6: null, settings: {},
    targetPlatform: 'any', active: false, revision: 0, createdAt: '', updatedAt: ''
  } as const;
  const candidate = importedSnapshot(base, prepareImport(undefined, 0, document, undefined, 'new'));
  return { ...classifyConfig(text, document), checks: checkDraft(candidate) };
}
