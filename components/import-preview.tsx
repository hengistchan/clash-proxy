'use client';
import { useEffect, useRef, useState } from 'react';
import type { ConfigDiff } from '@/lib/config-diff';
import { apiRequest } from './api-client';
import { ConfigDiffView } from './config-diff-view';

interface Preview {
  currentRevision: number;
  changes: ConfigDiff;
  normalizationNotice: string;
}

export function ImportPreview({ profileId, token, yaml, onPreview }: {
  profileId: number;
  token: string;
  yaml: string;
  onPreview: (revision: number | null) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const callback = useRef(onPreview);
  callback.current = onPreview;
  useEffect(() => {
    request.current++;
    setPreview(null);
    setError('');
    setBusy(false);
    callback.current(null);
    return () => { request.current++; };
  }, [profileId, yaml]);
  async function load() {
    const current = ++request.current;
    setBusy(true);
    setError('');
    callback.current(null);
    try {
      const data = await apiRequest<Preview>(`/api/profiles/${profileId}/import-preview`, { method: 'POST', token, body: JSON.stringify({ yaml }) });
      if (current !== request.current) return;
      setPreview(data);
      callback.current(data.currentRevision);
    } catch (caught) {
      if (current === request.current) setError(caught instanceof Error ? caught.message : '无法预览导入变化');
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  return <section className="import-preview" aria-label="导入变化预览">
    <p className="delivery-note">导入会重新生成标准 YAML；注释、原始排版和锚点写法不会保留。请先预览语义变化，再确认替换。</p>
    <button className="button secondary" disabled={busy || !yaml.trim()} onClick={() => void load()}>{busy ? '正在预览…' : '预览导入变化'}</button>
    {preview ? <div><p className="delivery-note">基于当前版本 {preview.currentRevision} 的替换预览。修改导入文本后需要重新预览。</p><ConfigDiffView diff={preview.changes} /></div> : null}
    {error ? <pre className="inline-error" role="alert">{error}</pre> : null}
  </section>;
}
