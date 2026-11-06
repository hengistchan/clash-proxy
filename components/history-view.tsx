'use client';

import { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';

import { apiRequest } from './api-client';

interface Revision {
  id: number;
  revision: number;
  createdAt: string;
}

export function HistoryView({
  profileId,
  token,
  currentRevision,
  onRestored
}: {
  profileId: number;
  token: string;
  currentRevision: number;
  onRestored: (message: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ items: Revision[] }>(
        `/api/profiles/${profileId}/revisions`,
        { token }
      );
      setItems(data.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '版本加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [profileId, currentRevision]);

  async function restore(revision: number) {
    if (!window.confirm(`恢复到 revision ${revision}？当前状态会保留在历史中。`)) {
      return;
    }
    setBusy(revision);
    setError('');
    try {
      await apiRequest(
        `/api/profiles/${profileId}/revisions/${revision}/restore`,
        { method: 'POST', token }
      );
      await onRestored(`已恢复到 revision ${revision}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '恢复失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">VERSIONED / SQLITE SNAPSHOTS</p>
          <h2>配置版本</h2>
          <p>每次写入都会生成加密快照，可恢复到任意历史 revision。</p>
        </div>
        <History size={28} className="heading-glyph" />
      </div>
      {loading ? <div className="loading-line">加载版本…</div> : null}
      <div className="timeline">
        {items.map((item) => (
          <article
            className={`timeline-item${
              item.revision === currentRevision ? ' current' : ''
            }`}
            key={item.id}
          >
            <div className="timeline-dot" />
            <div>
              <strong>REV {String(item.revision).padStart(3, '0')}</strong>
              <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
            </div>
            {item.revision === currentRevision ? (
              <span className="current-label">CURRENT</span>
            ) : (
              <button
                className="button secondary small"
                disabled={busy === item.revision}
                onClick={() => restore(item.revision)}
              >
                <RotateCcw size={14} />
                恢复
              </button>
            )}
          </article>
        ))}
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </section>
  );
}
