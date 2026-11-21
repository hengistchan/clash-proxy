'use client';

import { useEffect, useState } from 'react';
import type { CandidatePreview } from '@/lib/candidate-preview';
import { apiRequest } from './api-client';
import { ConfigDiffView } from './config-diff-view';
import { CodePreview } from './config-export-preview';
import { ValidationIssues } from './validation-issues';

export function PublicationCandidatePreview({ endpoint, token, language, onReviewed }: {
  endpoint: string; token: string; language: 'yaml' | 'ini';
  onReviewed: (fingerprint: string | undefined) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ preview: CandidatePreview } | { error: string }>();

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<CandidatePreview>(endpoint, { token, signal: controller.signal }).then(preview => {
      if (!controller.signal.aborted) {
        setResult({ preview });
        onReviewed(preview.fingerprint);
      }
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : '无法读取待发布版。' });
    });
    return () => controller.abort();
  }, [attempt, endpoint, token, onReviewed]);

  function refresh() {
    onReviewed(undefined);
    setResult(undefined);
    setAttempt(value => value + 1);
  }

  return <section id="publication-candidate-preview" className="config-export-preview" aria-label="待发布版预览">
    {!result ? <p role="status" className="delivery-note">正在读取待发布版…</p> : 'error' in result ? <>
      <p role="alert" className="inline-error">{result.error}</p>
      <button type="button" className="button secondary small" onClick={refresh}>重试预览</button>
    </> : <>
      <div className="config-preview-heading">
        <h3>待发布版 {result.preview.revision}</h3>
        <button type="button" className="button secondary small" onClick={refresh}>刷新待发布版预览</button>
      </div>
      <p className="delivery-note">{result.preview.servedRevision === null ? '设备暂无可下载版本。'
        : `设备当前可下载版 ${result.preview.servedRevision} · ${result.preview.outputChanged ? '生成的配置内容有变化' : '生成的配置文本相同'}`}</p>
      {result.preview.warnings.length ? <ValidationIssues issues={result.preview.warnings} /> : null}
      {result.preview.changes ? <details className="export-contract" open>
        <summary>相对设备版的编辑变更</summary>
        <ConfigDiffView diff={result.preview.changes} />
      </details> : null}
      {result.preview.hasManagedSources ? <p className="delivery-note">托管来源显示为占位地址，设备下载时会生成交付链接。</p> : null}
      <CodePreview text={result.preview.content} language={language} />
    </>}
  </section>;
}
