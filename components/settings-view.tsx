'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';

import type { JsonObject, LogLevel, ProfileMode, Snapshot } from '@/lib/types';
import { isJsonObject } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';
import { SelectField, SwitchField } from './ui';

const MANAGED_DNS_KEYS = new Set([
  'nameserver',
  'default-nameserver',
  'proxy-server-nameserver',
  'fallback',
  'fake-ip-range',
  'fake-ip-filter'
]);

function lines(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join('\n') : '';
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SettingsView({
  snapshot,
  profileId,
  token,
  onSaved
}: {
  snapshot: Snapshot;
  profileId: number;
  token: string;
  onSaved: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<ProfileMode>(snapshot.profile.mode);
  const [logLevel, setLogLevel] = useState<LogLevel>(snapshot.profile.logLevel);
  const [ipv6, setIpv6] = useState(snapshot.profile.ipv6 === true);
  const [nameserver, setNameserver] = useState('');
  const [defaultNameserver, setDefaultNameserver] = useState('');
  const [proxyNameserver, setProxyNameserver] = useState('');
  const [fallback, setFallback] = useState('');
  const [fakeIpRange, setFakeIpRange] = useState('');
  const [fakeIpFilter, setFakeIpFilter] = useState('');
  const [advancedDns, setAdvancedDns] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dns = isJsonObject(snapshot.profile.settings.dns)
      ? snapshot.profile.settings.dns
      : {};
    setMode(snapshot.profile.mode);
    setLogLevel(snapshot.profile.logLevel);
    setIpv6(snapshot.profile.ipv6 === true);
    setNameserver(lines(dns.nameserver));
    setDefaultNameserver(lines(dns['default-nameserver']));
    setProxyNameserver(lines(dns['proxy-server-nameserver']));
    setFallback(lines(dns.fallback));
    setFakeIpRange(String(dns['fake-ip-range'] || ''));
    setFakeIpFilter(lines(dns['fake-ip-filter']));
    const rest = Object.fromEntries(
      Object.entries(dns).filter(([key]) => !MANAGED_DNS_KEYS.has(key))
    );
    setAdvancedDns(JSON.stringify(rest, null, 2));
  }, [snapshot]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      let rest: unknown = {};
      try {
        rest = JSON.parse(advancedDns || '{}');
      } catch {
        throw new Error('DNS 高级配置不是合法 JSON');
      }
      if (!rest || typeof rest !== 'object' || Array.isArray(rest)) {
        throw new Error('DNS 高级配置必须是 JSON 对象');
      }
      const dns: JsonObject = {
        ...(rest as JsonObject),
        nameserver: splitLines(nameserver),
        'default-nameserver': splitLines(defaultNameserver),
        'proxy-server-nameserver': splitLines(proxyNameserver),
        fallback: splitLines(fallback),
        ...(fakeIpRange.trim() ? { 'fake-ip-range': fakeIpRange.trim() } : {}),
        'fake-ip-filter': splitLines(fakeIpFilter)
      };
      await apiRequest(`/api/profiles/${profileId}/settings`, {
        method: 'PUT',
        token,
        body: JSON.stringify({
          mode,
          logLevel,
          ipv6,
          settings: { ...snapshot.profile.settings, dns }
        })
      });
      await onSaved('全局设置与 DNS 已保存。');
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length) {
        setError(caught.issues.map((issue) => issue.message).join('\n'));
      } else {
        setError(caught instanceof Error ? caught.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">PROFILE / RUNTIME</p>
          <h2>全局设置与 DNS</h2>
          <p>模式、日志、IPv6、上游 DNS、Fake-IP 和策略性 DNS 字段。</p>
        </div>
        <button className="button primary" onClick={save} disabled={saving}>
          <Save size={16} />
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>

      <div className="settings-grid">
        <SelectField
          label="运行模式"
          value={mode}
          onValueChange={(value) => setMode(value as ProfileMode)}
          options={[
            { value: 'rule', label: 'rule / 按规则分流' },
            { value: 'global', label: 'global / 全局代理' },
            { value: 'direct', label: 'direct / 全部直连' }
          ]}
        />
        <SelectField
          label="日志级别"
          value={logLevel}
          onValueChange={(value) => setLogLevel(value as LogLevel)}
          options={['silent', 'info', 'warning', 'error', 'debug'].map((item) => ({
            value: item,
            label: item
          }))}
        />
        <div className="field wide">
          <SwitchField
            label="IPv6"
            checked={ipv6}
            onCheckedChange={setIpv6}
            description="写入顶层 ipv6；关闭时 Stash 自身连接和 DNS 不返回 AAAA。"
          />
        </div>
      </div>

      <div className="section-rule">
        <span>DNS / UPSTREAM</span>
      </div>
      <div className="settings-grid dns-grid">
        <label className="field">
          <span>nameserver</span>
          <textarea
            className="code-input compact"
            rows={6}
            value={nameserver}
            onChange={(event) => setNameserver(event.target.value)}
            placeholder={'223.5.5.5\n119.29.29.29'}
          />
        </label>
        <label className="field">
          <span>default-nameserver</span>
          <textarea
            className="code-input compact"
            rows={6}
            value={defaultNameserver}
            onChange={(event) => setDefaultNameserver(event.target.value)}
          />
        </label>
        <label className="field">
          <span>proxy-server-nameserver</span>
          <textarea
            className="code-input compact"
            rows={6}
            value={proxyNameserver}
            onChange={(event) => setProxyNameserver(event.target.value)}
          />
        </label>
        <label className="field">
          <span>fallback</span>
          <textarea
            className="code-input compact"
            rows={6}
            value={fallback}
            onChange={(event) => setFallback(event.target.value)}
          />
        </label>
        <label className="field">
          <span>fake-ip-range</span>
          <input
            className="input mono"
            value={fakeIpRange}
            onChange={(event) => setFakeIpRange(event.target.value)}
            placeholder="198.18.0.1/16"
          />
        </label>
        <label className="field">
          <span>fake-ip-filter（每行一个）</span>
          <textarea
            className="code-input compact"
            rows={8}
            value={fakeIpFilter}
            onChange={(event) => setFakeIpFilter(event.target.value)}
          />
        </label>
        <label className="field wide">
          <span>nameserver-policy / fallback-filter / 其他 DNS JSON</span>
          <textarea
            className="code-input"
            rows={12}
            value={advancedDns}
            onChange={(event) => setAdvancedDns(event.target.value)}
            placeholder={'{\n  "nameserver-policy": {\n    "rule-set:company": "10.0.0.53"\n  }\n}'}
          />
          <small>完整保留 Stash 其他 DNS 字段，不认识的字段也不会丢失。</small>
        </label>
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </section>
  );
}
