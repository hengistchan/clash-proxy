import { getDb } from './db';
import { HttpError } from './http';

export function revisionEtag(revision: number): string {
  return `"${revision}"`;
}

function expectedRevision(request: Request): number {
  const value = request.headers.get('if-match');
  if (!value) {
    throw new HttpError(428, '写入需要 If-Match 版本号。请先读取配置快照。', [], { code: 'revision.required' });
  }
  const match = /^"(0|[1-9]\d*)"$/.exec(value);
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision)) {
    throw new HttpError(400, 'If-Match 必须是配置快照的强 ETag，例如 "12"。', [], { code: 'revision.invalid' });
  }
  return revision;
}

/** The comparison and all nested repository writes share one SQLite write lock. */
export function withProfileRevision(request: Request, profileId: number, operation: () => Response): Response {
  const expected = expectedRevision(request);
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(profileId) as { revision: number } | undefined;
    if (!row) throw new HttpError(404, 'Profile not found');
    if (row.revision !== expected) {
      throw new HttpError(409, '配置已被其他会话更新，你的输入仍保留。请读取最新快照，比较修改后再保存。', [], {
        code: 'revision.conflict', expectedRevision: expected, currentRevision: row.revision
      });
    }
    const response = operation();
    const updated = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(profileId) as { revision: number } | undefined;
    if (updated) response.headers.set('ETag', revisionEtag(updated.revision));
    return response;
  }).immediate();
}
