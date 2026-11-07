import { getDb } from './db';
import { decryptJson } from './crypto';
import { HttpError } from './http';
import { compareConfigurations } from './config-diff';
import { getCompilationSnapshot, importYaml } from './repository';
import type { Snapshot } from './types';

export const NORMALIZATION_NOTICE = '导入会保留受支持字段的含义，并重新生成标准 YAML；注释、原始排版和锚点写法不会保留。下面只展示语义变化摘要，不显示私人连接参数或凭据。';

export function compareRevision(profileId: number, targetRevision: number) {
  // Initialize before opening a consistent read transaction.
  getCompilationSnapshot(profileId);
  return getDb().transaction(() => {
    const current = getCompilationSnapshot(profileId);
    const row = getDb().prepare('SELECT config_ciphertext FROM revisions WHERE profile_id = ? AND revision = ?').get(profileId, targetRevision) as { config_ciphertext: string } | undefined;
    if (!row) throw new HttpError(404, 'Revision not found or no longer retained');
    const target = decryptJson<Snapshot>(row.config_ciphertext);
    return { baseRevision: current.profile.revision, currentRevision: current.profile.revision, targetRevision, changes: compareConfigurations(current, target) };
  })();
}

export function previewImport(profileId: number, yaml: string) {
  getCompilationSnapshot(profileId);
  class PreviewRollback extends Error {}
  let preview: { currentRevision: number; changes: ReturnType<typeof compareConfigurations>; normalizationNotice: string } | undefined;
  try {
    // Reuse the exact import pipeline, including retained sources and names.
    // The sentinel always rolls back resources, history, compiled output and pruning.
    getDb().transaction(() => {
      const before = getCompilationSnapshot(profileId);
      importYaml(profileId, yaml);
      const after = getCompilationSnapshot(profileId);
      preview = { currentRevision: before.profile.revision, changes: compareConfigurations(before, after), normalizationNotice: NORMALIZATION_NOTICE };
      throw new PreviewRollback();
    }).immediate();
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  if (!preview) throw new HttpError(500, 'Unable to preview import');
  return preview;
}
