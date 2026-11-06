'use client';

import { useState } from 'react';
import { Download, ExternalLink, ShieldCheck } from 'lucide-react';

import type { Snapshot, ValidationResult } from '@/lib/types';

import { downloadBlob, filenameFromDisposition } from './api-client';
import { StatusBadge } from './ui';

export function ExportView({
  snapshot,
  validation,
  profileId,
  token
}: {
  snapshot: Snapshot;
  validation: ValidationResult;
  profileId: number;
  token: string;
}) {
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [template, setTemplate] = useState('production');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    filename: string;
    size: number;
    sha256: string;
    rules: number;
  } | null>(null);

  async function generate() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };
      if (token) headers['X-Admin-Token'] = token;
      const response = await fetch(`/api/profiles/${profileId}/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: subscriptionUrl, template })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.detail || `生成失败（HTTP ${response.status}）`);
      }
      const blob = await response.blob();
      const filename = filenameFromDisposition(
        response.headers.get('content-disposition')
      );
      downloadBlob(blob, filename);
      setResult({
        filename,
        size: blob.size,
        sha256: response.headers.get('x-config-sha256') || 'unknown',
        rules: Number(response.headers.get('x-rule-count') || 0)
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成失败');
    } finally {
      setBusy(false);
    }
  }

  const invalid = validation.issues.filter((issue) => issue.severity === 'error');

  return (
    <section className="panel export-panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">BUILD / COMPLETE YAML</p>
          <h2>生成完整 Stash 配置</h2>
          <p>
            将当前 SQLite 快照编译为单文件 YAML。私人订阅地址只用于本次请求，
            不写入数据库。
          </p>
        </div>
        <StatusBadge tone={invalid.length ? 'bad' : 'good'}>
          {invalid.length ? `${invalid.length} ERRORS` : 'VALID'}
        </StatusBadge>
      </div>

      <div className="export-layout">
        <div className="export-form">
          <label className="field wide">
            <span>GLaDOS 私人 YAML 订阅地址</span>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              value={subscriptionUrl}
              onChange={(event) => setSubscriptionUrl(event.target.value)}
              placeholder="https://…"
            />
            <small>仅接受 HTTPS；不抓取、不落库、不使用访问日志记录。</small>
          </label>
          <label className="field">
            <span>配置模板</span>
            <select
              className="input"
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
            >
              <option value="production">Production / 包含广告规则集</option>
              <option value="no_ads">No Ads / 排除广告规则集</option>
            </select>
          </label>
          <button
            className="button primary build-button"
            onClick={generate}
            disabled={busy || invalid.length > 0 || !subscriptionUrl.trim()}
          >
            <Download size={17} />
            {busy ? '正在编译…' : '编译并下载 YAML'}
          </button>
        </div>

        <aside className="export-contract">
          <div className="contract-top">
            <ShieldCheck size={20} />
            <span>API CONTRACT</span>
          </div>
          <code>GET /api?url=…&amp;template=production</code>
          <p>
            浏览器使用 POST，避免私人 URL 进入地址栏；兼容链接仍保留 GET。
          </p>
          <div className="contract-stats">
            <div>
              <strong>{snapshot.proxyGroups.length}</strong>
              <span>策略组</span>
            </div>
            <div>
              <strong>{snapshot.ruleProviders.length}</strong>
              <span>规则集</span>
            </div>
            <div>
              <strong>{snapshot.rules.filter((rule) => rule.enabled).length}</strong>
              <span>规则</span>
            </div>
          </div>
        </aside>
      </div>

      {invalid.length ? (
        <div className="validation-block error-block">
          <strong>导出被阻止</strong>
          {invalid.slice(0, 8).map((issue, index) => (
            <p key={`${issue.code}-${index}`}>{issue.message}</p>
          ))}
        </div>
      ) : null}

      {error ? <pre className="inline-error">{error}</pre> : null}

      {result ? (
        <div className="export-result">
          <div className="result-check">✓</div>
          <div>
            <strong>{result.filename}</strong>
            <p>
              {result.size.toLocaleString()} bytes · {result.rules} rules · SHA-256{' '}
              <code>{result.sha256}</code>
            </p>
          </div>
          <a className="button secondary" href="/" target="_blank">
            <ExternalLink size={15} />
            服务状态
          </a>
        </div>
      ) : null}
    </section>
  );
}
