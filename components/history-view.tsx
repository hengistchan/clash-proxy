'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { ConfigDiff } from '@/lib/config-diff';
import { Modal } from './ui';
import { ConfigDiffView } from './config-diff-view';

import { apiRequest } from './api-client';
import { useUnsavedChanges } from './unsaved-changes';

interface Revision {
  id: number;
  revision: number;
  createdAt: string;
}

interface RevisionPage {
  items: Revision[];
  nextCursor: number | null;
  retentionLimit: number;
  retainedCount: number;
  oldestRevision: number | null;
}

interface RevisionComparison {
  currentRevision: number;
  targetRevision: number;
  changes: ConfigDiff;
}

const REVISION_PAGE_SIZE = 50;

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
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [retention, setRetention] = useState<Pick<RevisionPage, 'retentionLimit' | 'retainedCount' | 'oldestRevision'> | null>(null);
  const [preview, setPreview] = useState<RevisionComparison | null>(null);
  const [previewRevision, setPreviewRevision] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);
  const mutationLock = useRef(false);
  const loadRequest = useRef(0);
  useUnsavedChanges(false, busy !== null);

  const load = useCallback(async (before?: number) => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError('');
    if (before === undefined) {
      setItems([]);
      setNextCursor(null);
    }
    try {
      const params = new URLSearchParams({ limit: String(REVISION_PAGE_SIZE) });
      if (before !== undefined) params.set('before', String(before));
      const data = await apiRequest<RevisionPage>(
        `/api/profiles/${profileId}/revisions?${params}`,
        { token }
      );
      if (request !== loadRequest.current) return;
      setItems((current) =>
        before === undefined ? data.items : [...current, ...data.items]
      );
      setNextCursor(data.nextCursor);
      setRetention({ retentionLimit: data.retentionLimit, retainedCount: data.retainedCount, oldestRevision: data.oldestRevision });
    } catch (caught) {
      if (request === loadRequest.current)
        setError(caught instanceof Error ? caught.message : '版本加载失败');
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [profileId, token]);

  useEffect(() => {
    void load();
    return () => { loadRequest.current++; };
  }, [load, currentRevision]);

  async function inspectRevision(revision: number) {
    const requestId = ++previewRequest.current;
    setPreviewRevision(revision);
    setPreview(null);
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const data = await apiRequest<RevisionComparison>(`/api/profiles/${profileId}/revisions/${revision}/compare`, { token });
      if (requestId === previewRequest.current) setPreview(data);
    } catch (caught) {
      if (requestId === previewRequest.current) setPreviewError(caught instanceof Error ? caught.message : '读取变化失败');
    } finally {
      if (requestId === previewRequest.current) setPreviewLoading(false);
    }
  }

  async function restore() {
    if (mutationLock.current || !preview || preview.currentRevision < currentRevision) return;
    const revision = preview.targetRevision;
    mutationLock.current = true;
    setBusy(revision);
    setPreviewError('');
    try {
      await apiRequest(
        `/api/profiles/${profileId}/revisions/${revision}/restore`,
        { method: 'POST', token, expectedRevision: preview.currentRevision }
      );
      setPreviewRevision(null);
      setPreview(null);
      await onRestored(`已恢复到 revision ${revision}。`);
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : '恢复失败');
    } finally {
      mutationLock.current = false;
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">VERSIONED / SQLITE SNAPSHOTS</p>
          <h2>配置版本</h2>
          <p>先查看历史版本与当前配置的变化，再确认恢复；恢复会生成一个新版本。</p>
        </div>
        <History size={28} className="heading-glyph" />
      </div>
      {retention ? <p className="history-retention delivery-note">保留最近 {retention.retentionLimit} 个版本，并额外保护当前版本和最近成功版本；目前保留 {retention.retainedCount} 个，最早为版本 {retention.oldestRevision ?? '—'}。更早的历史会自动清理。</p> : null}
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
                disabled={busy !== null || loading}
                onClick={() => void inspectRevision(item.revision)}
              >
                <RotateCcw size={14} />
                {busy === item.revision ? '恢复中…' : '查看变化'}
              </button>
            )}
          </article>
        ))}
      </div>
      {items.length === 0 && !loading && !error ? (
        <div className="empty-state">还没有可显示的配置版本。</div>
      ) : null}
      {nextCursor !== null ? (
        <button
          className="button secondary small"
          disabled={loading || busy !== null}
          onClick={() => void load(nextCursor)}
        >
          {loading ? '加载中…' : '加载更早版本'}
        </button>
      ) : null}
      {error ? <pre className="inline-error">{error}</pre> : null}
      <Modal open={previewRevision !== null} onOpenChange={(open) => { if (!open && busy === null) { previewRequest.current++; setPreviewRevision(null); } }} title={`恢复版本 ${previewRevision ?? ''} 前的变化`} description="以下展示从当前配置恢复到所选历史版本将产生的语义变化。私人参数与凭据不显示。" wide footer={<>
        <button className="button secondary" disabled={busy !== null} onClick={() => { previewRequest.current++; setPreviewRevision(null); }}>取消</button>
        <button className="button secondary" disabled={busy !== null || previewLoading || previewRevision === null} onClick={() => previewRevision !== null && void inspectRevision(previewRevision)}>重新预览</button>
        <button className="button primary" disabled={busy !== null || !preview || preview.currentRevision < currentRevision} onClick={() => void restore()}>{busy !== null ? '恢复中…' : '确认恢复'}</button>
      </>}>
        {previewLoading ? <p role="status">正在比较版本…</p> : null}
        {preview ? <><p className="delivery-note">当前版本 {preview.currentRevision} → 历史版本 {preview.targetRevision}</p><ConfigDiffView diff={preview.changes} /></> : null}
        {preview && preview.currentRevision < currentRevision ? <p className="inline-error" role="alert">当前配置已变化，请重新预览后再恢复。</p> : null}
        {previewError ? <pre className="inline-error" role="alert">{previewError}</pre> : null}
      </Modal>
    </section>
  );
}
