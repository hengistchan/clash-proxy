'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Search } from 'lucide-react';
import type { ValidationIssue } from '@/lib/types';
import { ValidationIssues } from './validation-issues';
import { downloadBlob, filenameFromDisposition } from './api-client';
import type { mountPreviewEditor } from './config-preview-monaco';

interface PreviewFile {
  blob: Blob;
  text: string;
  filename: string;
  revision: string;
}

function CodePreview({ file, language, downloadLabel }: { file: PreviewFile; language: 'yaml' | 'ini'; downloadLabel: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<typeof mountPreviewEditor>>(null);
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => {
    // A native text control gives touch users selection, scrolling and copying.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    let active = true;
    void import('./config-preview-monaco').then(({ mountPreviewEditor }) => {
      if (!active || !host.current) return;
      editor.current = mountPreviewEditor(host.current, file.text, language);
      setEnhanced(true);
    }).catch(() => { /* The read-only text remains available if the editor cannot load. */ });
    return () => {
      active = false;
      editor.current?.dispose();
      editor.current = null;
    };
  }, [file.text, language]);

  return <>
    <div className="delivery-actions">
      {enhanced ? <button type="button" className="button secondary small" onClick={() => editor.current?.find()}>
        <Search size={15} />搜索配置
      </button> : null}
      <button type="button" className="button secondary small" onClick={() => downloadBlob(file.blob, file.filename)}>
        <Download size={15} />{downloadLabel}
      </button>
    </div>
    <div className="config-preview-code">
      <div ref={host} className="config-preview-monaco" aria-hidden={!enhanced} />
      {!enhanced ? <textarea className="config-preview-text" aria-label="导出配置内容（只读）" readOnly value={file.text} /> : null}
    </div>
  </>;
}

export function ConfigExportPreview({
  id, endpoint, client, language, token, available, downloadLabel = '下载此预览', onFixIssue
}: {
  id: string; endpoint: string; client: string; language: 'yaml' | 'ini'; token: string; available: boolean;
  downloadLabel?: string;
  onFixIssue?: (issue: ValidationIssue) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ attempt: number; file?: PreviewFile; error?: string; issues?: ValidationIssue[] }>();
  const current = result?.attempt === attempt ? result : undefined;

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(endpoint, {
          headers: token ? { 'X-Admin-Token': token } : {},
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          if (!controller.signal.aborted) setResult({
            attempt, error: error?.detail || '无法读取导出配置',
            issues: Array.isArray(error?.issues) ? error.issues : undefined
          });
          return;
        }
        const blob = await response.blob();
        const text = await blob.text();
        if (!controller.signal.aborted) setResult({
          attempt,
          file: {
            blob, text,
            filename: filenameFromDisposition(response.headers.get('Content-Disposition')),
            revision: response.headers.get('X-Config-Revision') ?? '未知'
          }
        });
      } catch (error) {
        if (!controller.signal.aborted) setResult({
          attempt, error: error instanceof Error ? error.message : '无法读取导出配置'
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, available, endpoint, token]);

  return <section id={id} className="config-export-preview" aria-label="导出配置预览">
    <div className="config-preview-heading">
      <div>
        <h3>{client} 导出配置预览</h3>
        {available && current?.file ? <p className="delivery-note">
          版本 {current.file.revision} · <span className="mono">{current.file.filename}</span>
        </p> : null}
      </div>
      {available ? <button type="button" className="button secondary small" disabled={!current}
        onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />刷新预览</button> : null}
    </div>
    {!available ? <p className="delivery-note">此客户端还没有可预览的交付版本。</p>
      : current?.error ? <>
        <p className="inline-error" role="alert">{current.error}</p>
        {current.issues?.length ? <ValidationIssues issues={current.issues} onFix={onFixIssue} /> : null}
      </>
      : current?.file ? <>
        <p className="delivery-note">只读预览。文件可能包含私人地址和认证信息。</p>
        <CodePreview key={attempt} file={current.file} language={language} downloadLabel={downloadLabel} />
      </> : <p className="delivery-note" role="status">正在读取导出配置…</p>}
  </section>;
}
