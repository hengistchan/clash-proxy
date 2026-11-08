'use client';

import { useEffect, useState } from 'react';
import type { ProxyRewriteRule } from '@/lib/types';
import type { transformProxySource } from '@/lib/proxy-source-transform';
import { SelectField } from './ui';

type Preview = ReturnType<typeof transformProxySource>['preview'];
const preset: ProxyRewriteRule = { matchName: '', operation: 'fill', field: 'udp', value: true };

export function ProxySourceRewrites({ rules, onChange, sourceKey, onPreview }: {
  rules: ProxyRewriteRule[];
  onChange: (rules: ProxyRewriteRule[]) => void;
  sourceKey: string;
  onPreview: (signal: AbortSignal) => Promise<Preview>;
}) {
  const [pending, setPending] = useState<AbortController>();
  const [result, setResult] = useState<{ key: string; data?: Preview; error?: string }>();
  const key = JSON.stringify([sourceKey, rules]);
  useEffect(() => () => pending?.abort(), [key, pending]);
  const preview = result?.key === key ? result.data : undefined;
  const error = result?.key === key ? result.error : undefined;

  function patch(index: number, value: Partial<ProxyRewriteRule>) {
    onChange(rules.map((rule, position) => position === index ? { ...rule, ...value } : rule));
  }

  function move(index: number, offset: number) {
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  }

  async function runPreview() {
    const controller = new AbortController();
    setPending(controller);
    setResult(undefined);
    try {
      const data = await onPreview(controller.signal);
      if (!controller.signal.aborted) setResult({ key, data });
    } catch (caught) {
      if (!controller.signal.aborted)
        setResult({ key, error: caught instanceof Error ? caught.message : '无法预览代理源。' });
    } finally {
      setPending(undefined);
    }
  }

  const label = (value: Preview['examples'][number]['before']) =>
    value === 'missing' ? '未设置' : value === 'other' ? '非布尔值' : String(value);

  return (
    <details className="wide">
      <summary>节点改写 · Stash{rules.length > 0 ? `（${rules.length} 条）` : ''}</summary>
      <p>按顺序匹配节点并修改字段。留空匹配条件表示全部节点。「仅补缺失」保留来源已有的值。</p>
      {rules.map((rule, index) => (
        <fieldset key={index} className="form-grid proxy-rewrite-rule">
          <legend>改写规则 {index + 1}</legend>
          <label className="field wide">
            <span>节点名称正则</span>
            <input className="input mono" value={rule.matchName} maxLength={256}
              placeholder="例如 ^HK-，留空匹配所有节点"
              onChange={(event) => patch(index, { matchName: event.target.value })} />
          </label>
          <label className="field">
            <span>协议类型（可选）</span>
            <input className="input mono" value={rule.protocol ?? ''} maxLength={32} placeholder="例如 ss"
              onChange={(event) => patch(index, { protocol: event.target.value.trim().toLowerCase() || undefined })} />
          </label>
          <SelectField label="操作" value={rule.operation} onValueChange={(value) => patch(index, { operation: value === 'set' ? 'set' : 'fill' })}
            options={[{ value: 'fill', label: '仅补缺失' }, { value: 'set', label: '覆盖已有值' }]} />
          <SelectField label="节点字段" value={rule.field} onValueChange={(value) => patch(index, { field: value as ProxyRewriteRule['field'] })}
            options={['udp', 'udp-over-tcp', 'tfo'].map((value) => ({ value, label: value }))} />
          <SelectField label="字段值" value={String(rule.value)} onValueChange={(value) => patch(index, { value: value === 'true' })}
            options={[{ value: 'true', label: '开启（true）' }, { value: 'false', label: '关闭（false）' }]} />
          <div className="delivery-actions wide">
            <button type="button" className="button secondary small" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
            <button type="button" className="button secondary small" disabled={index === rules.length - 1} onClick={() => move(index, 1)}>下移</button>
            <button type="button" className="button secondary small" onClick={() => onChange(rules.filter((_, position) => index !== position))}>删除这条规则</button>
          </div>
        </fieldset>
      ))}
      <div className="delivery-actions">
        <button type="button" className="button secondary" disabled={rules.length >= 20} onClick={() => onChange([...rules, { ...preset }])}>添加改写规则</button>
        <button type="button" className="button secondary" disabled={!rules.length || Boolean(pending)} onClick={() => void runPreview()}>
          {pending ? '正在下载并预览…' : '预览改写结果'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {preview && <div aria-live="polite">
        <p>共 {preview.totalNodes} 个节点，匹配 {preview.matchedNodes} 个，实际改写 {preview.changedNodes} 个。</p>
        {preview.examples.length > 0 && <ul>
          {preview.examples.map((example) => <li key={`${example.node}-${example.field}`}>
            节点 #{example.node} · {example.field}：{label(example.before)} → {label(example.after)}
          </li>)}
        </ul>}
      </div>}
    </details>
  );
}
