'use client';

import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';

import type { JsonObject, LogLevel, ProfileMode, Snapshot } from '@/lib/types';
import { isJsonObject } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';
import { SelectField, SwitchField } from './ui';
import { ConfigFields } from './config-fields';
import { useUnsavedChanges } from './unsaved-changes';

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

function settingsDraft(snapshot: Snapshot) {
  const dns = isJsonObject(snapshot.profile.settings.dns)
    ? snapshot.profile.settings.dns
    : {};
  return {
    mode: snapshot.profile.mode,
    targetPlatform: snapshot.profile.targetPlatform,
    logLevel: snapshot.profile.logLevel,
    ipv6: snapshot.profile.ipv6 === true,
    nameserver: lines(dns.nameserver),
    defaultNameserver: lines(dns['default-nameserver']),
    proxyNameserver: lines(dns['proxy-server-nameserver']),
    fallback: lines(dns.fallback),
    fakeIpRange: String(dns['fake-ip-range'] || ''),
    fakeIpFilter: lines(dns['fake-ip-filter']),
    advancedDns: JSON.stringify(Object.fromEntries(
      Object.entries(dns).filter(([key]) => !MANAGED_DNS_KEYS.has(key))
    ), null, 2)
  };
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
  const [targetPlatform, setTargetPlatform] = useState(
    snapshot.profile.targetPlatform
  );
  const formRoot = useRef<HTMLElement>(null);
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
  const [baseline, setBaseline] = useState<string | null>(null);
  const fingerprint = JSON.stringify({
    mode, targetPlatform, logLevel, ipv6, nameserver, defaultNameserver,
    proxyNameserver, fallback, fakeIpRange, fakeIpFilter, advancedDns
  });
  const dirty = baseline !== null && fingerprint !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedProfile = useRef(profileId);
  useUnsavedChanges(dirty, saving, resetDraft);

  function resetDraft() {
    dirtyRef.current = false;
    loadedProfile.current = profileId;
    const draft = settingsDraft(snapshot);
    setMode(draft.mode);
    setTargetPlatform(draft.targetPlatform);
    setLogLevel(draft.logLevel);
    setIpv6(draft.ipv6);
    setNameserver(draft.nameserver);
    setDefaultNameserver(draft.defaultNameserver);
    setProxyNameserver(draft.proxyNameserver);
    setFallback(draft.fallback);
    setFakeIpRange(draft.fakeIpRange);
    setFakeIpFilter(draft.fakeIpFilter);
    setAdvancedDns(draft.advancedDns);
    setBaseline(JSON.stringify(draft));
    setError('');
  }

  useEffect(() => {
    if (loadedProfile.current === profileId && dirtyRef.current) return;
    resetDraft();
  }, [snapshot, profileId]);

  async function save() {
    if (saving) return;
    const invalid =
      formRoot.current?.querySelector<HTMLInputElement>('input:invalid');
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
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
          targetPlatform,
          logLevel,
          ipv6,
          settings: { ...snapshot.profile.settings, dns }
        })
      });
      dirtyRef.current = false;
      setBaseline(fingerprint);
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
    <section className="panel settings-panel" ref={formRoot} inert={saving} aria-busy={saving}>
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

      {dirty ? <p className="delivery-note" role="status">有未保存的修改，保存后才会检查并更新配置。</p> : null}

      <div className="settings-grid">
        <SelectField
          label="目标设备平台（用于兼容性检查）"
          value={targetPlatform}
          onValueChange={(value) =>
            setTargetPlatform(value as typeof targetPlatform)
          }
          options={[
            { value: 'any', label: '未指定 / 多平台' },
            { value: 'ios', label: 'iOS' },
            { value: 'tvos', label: 'tvOS' },
            { value: 'macos', label: 'macOS' }
          ]}
        />

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
          options={['silent', 'info', 'warning', 'error', 'debug'].map(
            (item) => ({
              value: item,
              label: item
            })
          )}
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
        <ConfigFields
          label="其他 DNS 字段"
          text={advancedDns}
          onChange={setAdvancedDns}
          suggestions={{ 'nameserver-policy': {}, 'follow-rule': false }}
        />
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </section>
  );
}
