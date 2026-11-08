'use client';

import { useEffect, useState } from 'react';
import type { ProxyRewriteRule, ProxyRewriteValue } from '@/lib/types';
import type { transformProxySource } from '@/lib/proxy-source-transform';
import { SelectField } from './ui';
import {
  isProxyRewriteField, isProxyRewriteValue, isRewriteShortcut, PROXY_REWRITE_SHORTCUTS,
  PROXY_REWRITE_FIELD_ERROR, PROXY_REWRITE_FIELD_PATTERN, PROXY_REWRITE_VALUE_MAX
} from '@/lib/proxy-rewrite-fields';

type Preview = ReturnType<typeof transformProxySource>['preview'];
export type ProxyRewriteDraft = Omit<ProxyRewriteRule, 'value'> & { value: ProxyRewriteValue | null; custom?: true };

export function serializeProxyRewrites(rules: ProxyRewriteDraft[]): ProxyRewriteRule[] {
  return rules.map(({ custom: _custom, ...rule }, index) => {
    const field = rule.field.trim();
    if (!isProxyRewriteField(field)) throw new Error(`第 ${index + 1} 条：${PROXY_REWRITE_FIELD_ERROR}`);
    if (!isProxyRewriteValue(rule.value) || (isRewriteShortcut(field) && typeof rule.value !== 'boolean')) {
      throw new Error(`请为第 ${index + 1} 条节点改写规则填写有效的字段值。`);
    }
    return { ...rule, field, value: rule.value };
  });
}

const preset: ProxyRewriteDraft = { matchName: '', operation: 'fill', field: 'udp', value: true };

export function ProxySourceRewrites({ rules, onChange, sourceKey, onPreview }: {
  rules: ProxyRewriteDraft[];
  onChange: (rules: ProxyRewriteDraft[]) => void;
  sourceKey: string;
  onPreview: (signal: AbortSignal) => Promise<Preview>;
}) {
  const [pending, setPending] = useState<AbortController>();
  const [result, setResult] = useState<{ key: string; data?: Preview; error?: string }>();
  const key = JSON.stringify([sourceKey, rules]);
  useEffect(() => () => pending?.abort(), [key, pending]);
  const preview = result?.key === key ? result.data : undefined;
  const error = result?.key === key ? result.error : undefined;

  function patch(index: number, value: Partial<ProxyRewriteDraft>) {
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

  const valueLabel = (value: ProxyRewriteValue) => typeof value === 'string' ? JSON.stringify(value) : String(value);
  const previousLabel = (value: Preview['examples'][number]['before']) =>
    value === 'missing' ? '未设置' : value === 'other' ? '原值已隐藏' : valueLabel(value);
  const canPreview = rules.length > 0 && rules.every(({ field, value }) =>
    isProxyRewriteField(field.trim()) && isProxyRewriteValue(value) &&
    (!isRewriteShortcut(field.trim()) || typeof value === 'boolean'));


  return (
    <details className="wide">
      <summary>节点改写 · Stash{rules.length > 0 ? `（${rules.length} 条）` : ''}</summary>
      <p>按顺序匹配节点并修改字段。留空匹配条件表示全部节点。「仅补缺失」保留来源已有的值。</p>
      {rules.map((rule, index) => {
        const custom = rule.custom || !isRewriteShortcut(rule.field);
        const valueType = rule.value === null ? 'number' : typeof rule.value;
        return <fieldset key={index} className="form-grid proxy-rewrite-rule">
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
          <SelectField label="节点字段" value={custom ? 'custom' : rule.field} onValueChange={(value) => {
            if (value === 'custom') patch(index, { field: '', custom: true });
            else patch(index, { field: value, custom: undefined, value: typeof rule.value === 'boolean' ? rule.value : true });
          }} options={[
            ...PROXY_REWRITE_SHORTCUTS.map(value => ({ value, label: value })),
            { value: 'custom', label: '自定义字段' }
          ]} />
          {custom && <label className="field">
            <span>自定义字段名</span>
            <input className="input mono" value={rule.field} required maxLength={64} pattern={PROXY_REWRITE_FIELD_PATTERN}
              placeholder="例如 sni 或 port" onChange={event => patch(index, { field: event.target.value })} />
            <small>填写节点的顶层字段；不可改写 name 或 type。</small>
          </label>}
          {custom && <SelectField label="值类型" value={valueType} onValueChange={type => {
            patch(index, { value: type === 'number' ? 0 : type === 'string' ? '' : true });
          }} options={[
            { value: 'string', label: '字符串' }, { value: 'number', label: '数字' }, { value: 'boolean', label: '布尔值' }
          ]} />}
          {valueType === 'boolean' ? <SelectField label="字段值" value={String(rule.value)}
            onValueChange={value => patch(index, { value: value === 'true' })}
            options={[{ value: 'true', label: '开启（true）' }, { value: 'false', label: '关闭（false）' }]} />
            : valueType === 'number' ? <label className="field">
              <span>字段值</span>
              <input className="input mono" type="number" step="any" required value={typeof rule.value === 'number' ? rule.value : ''}
                onChange={event => {
                  const number = event.currentTarget.valueAsNumber;
                  patch(index, { value: Number.isFinite(number) ? number : null });
                }} />
            </label> : <label className="field">
              <span>字段值</span>
              <input className="input mono" value={rule.value as string} maxLength={PROXY_REWRITE_VALUE_MAX}
                onChange={event => patch(index, { value: event.target.value })} />
            </label>}
          <div className="delivery-actions wide">
            <button type="button" className="button secondary small" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
            <button type="button" className="button secondary small" disabled={index === rules.length - 1} onClick={() => move(index, 1)}>下移</button>
            <button type="button" className="button secondary small" onClick={() => onChange(rules.filter((_, position) => index !== position))}>删除这条规则</button>
          </div>
        </fieldset>
      })}
      <div className="delivery-actions">
        <button type="button" className="button secondary" disabled={rules.length >= 20} onClick={() => onChange([...rules, { ...preset }])}>添加改写规则</button>
        <button type="button" className="button secondary" disabled={!canPreview || Boolean(pending)} onClick={() => void runPreview()}>
          {pending ? '正在下载并预览…' : '预览改写结果'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {preview && <div aria-live="polite">
        <p>共 {preview.totalNodes} 个节点，匹配 {preview.matchedNodes} 个，实际改写 {preview.changedNodes} 个。</p>
        {preview.examples.length > 0 && <ul>
          {preview.examples.map((example) => <li key={`${example.node}-${example.field}`}>
            节点 #{example.node} · {example.field}：{previousLabel(example.before)} → {valueLabel(example.after)}
          </li>)}
        </ul>}
      </div>}
    </details>
  );
}
