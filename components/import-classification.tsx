'use client';

import { useEffect, useState } from 'react';
import { ImportChecks } from './import-checks';
import type { inspectNewImport } from '@/lib/revision-comparison';
import type { classifyConfig } from '@/lib/config-import';
import { apiRequest } from './api-client';

export type ImportClassification = ReturnType<typeof classifyConfig>;

export function ImportClassificationView({ result }: { result: ImportClassification }) {
  return <div className="wide import-preview" aria-label="字段分类">
    <strong>识别为 {result.format === 'stash' ? 'Stash YAML' : 'Shadowrocket .conf'}</strong>
    {([
      ['通用配置', result.common], ['Stash 专用', result.stash], ['Shadowrocket 专用', result.shadowrocket]
    ] as const).map(([label, items]) => <p key={label} className="delivery-note">
      <strong>{label}：</strong>{items.length ? items.join('、') : '无'}
    </p>)}
  </div>;
}

export function InspectNewImport({ content, token, onReady }: { content: string; token: string; onReady: (text: string | null) => void }) {
  const [result, setResult] = useState<ReturnType<typeof inspectNewImport> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    onReady(null);
    setResult(null);
    setError('');
    if (!content.trim()) return;
    let active = true;
    const timer = window.setTimeout(() => {
      apiRequest<ReturnType<typeof inspectNewImport>>('/api/profiles/import-inspect', {
        method: 'POST', token, body: JSON.stringify({ content })
      }).then((data) => { if (active) { setResult(data); onReady(content); } })
        .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : '无法识别配置格式'); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [content, token, onReady]);
  return result ? <><ImportClassificationView result={result} /><ImportChecks checks={result.checks} /></> : error ? <p className="inline-error wide" role="alert">{error}</p> : null;
}
