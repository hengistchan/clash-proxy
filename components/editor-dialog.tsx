'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  HostEntry,
  JsonObject,
  ProxyGroup,
  ProxyNode,
  ProxyProvider,
  ResourceKind,
  RuleProvider,
  Snapshot,
  StashRule
} from '@/lib/types';
import { BUILTIN_POLICIES, RULE_OPTIONS, RULE_TYPES } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';
import { Modal, SelectField, SwitchField } from './ui';
import type { EditorPreset } from './relationships-view';
import { ConfigFields } from './config-fields';
import { useUnsavedChanges } from './unsaved-changes';
import {
  PROXY_GROUP_TYPE_DESCRIPTIONS,
  RULE_TYPE_DESCRIPTIONS,
  builtinPolicyDescription
} from '@/lib/rule-metadata';

type EditableResource =
  | ProxyNode
  | ProxyProvider
  | ProxyGroup
  | RuleProvider
  | StashRule
  | HostEntry
  | null;

function parseObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text || '{}');
  } catch {
    throw new Error(`${label}不是合法 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value as JsonObject;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function configWithout(config: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !keys.includes(key))
  ) as JsonObject;
}

export function EditorDialog({
  open,
  onOpenChange,
  resource,
  existing,
  initialValues,
  snapshot,
  profileId,
  token,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ResourceKind | null;
  existing: EditableResource;
  initialValues?: EditorPreset;
  snapshot: Snapshot;
  profileId: number;
  token: string;
  onSaved: (message: string) => Promise<void>;
}) {
  const formRoot = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [type, setType] = useState('');
  const [configText, setConfigText] = useState('{}');
  const [sourceType, setSourceType] = useState('remote');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceHeaders, setSourceHeaders] = useState('');
  const [clearSource, setClearSource] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [providerBehavior, setProviderBehavior] = useState('domain');
  const [providerType, setProviderType] = useState('inline');
  const [entriesText, setEntriesText] = useState('');
  const [groupProxies, setGroupProxies] = useState('');
  const [groupUse, setGroupUse] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [rulePayload, setRulePayload] = useState('');
  const [rulePolicy, setRulePolicy] = useState('DIRECT');
  const [ruleOptions, setRuleOptions] = useState<string[]>([]);
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [ruleNote, setRuleNote] = useState('');
  const [rulePriority, setRulePriority] = useState('1');
  const [hostPattern, setHostPattern] = useState('');
  const [hostValue, setHostValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [baseline, setBaseline] = useState<string | null>(null);
  const fingerprint = JSON.stringify({
    name, displayName, type, configText, sourceType, sourceUrl, sourceHeaders,
    clearSource, clearHeaders, providerBehavior, providerType, entriesText,
    groupProxies, groupUse, groupFilter, rulePayload, rulePolicy, ruleOptions,
    ruleEnabled, ruleNote, rulePriority, hostPattern, hostValue
  });
  const dirty = baseline !== null && fingerprint !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedIdentity = useRef('');
  const { confirmDiscard } = useUnsavedChanges(open && dirty, open && saving, resetDraft);

  function changeOpen(next: boolean) {
    if (next || confirmDiscard()) onOpenChange(next);
  }

  const policyOptions = useMemo(
    () => [
      ...BUILTIN_POLICIES.map((item) => ({
        value: item,
        label: item,
        description: builtinPolicyDescription(item)
      })),
      ...snapshot.proxies.map((item) => ({
        value: item.name,
        label: item.name,
        description: `直接节点 · ${item.type}：固定使用这个节点`
      })),
      ...snapshot.proxyGroups.map((item) => ({
        value: item.name,
        label: item.name,
        description: `策略组 · ${item.type}：${
          PROXY_GROUP_TYPE_DESCRIPTIONS[item.type]
        }`
      }))
    ],
    [snapshot]
  );

  function resetDraft() {
    if (!resource) return;
    dirtyRef.current = false;
    const identity = `${profileId}:${resource}:${existing?.id ?? 'new'}`;
    loadedIdentity.current = identity;
    setError('');
    const item = existing as Record<string, unknown> | null;
    const config = (item?.config || {}) as JsonObject;
    const itemType = String(item?.type || '');
    const itemPayload = String(item?.payload || initialValues?.payload || '');
    const terminal = snapshot.rules.at(-1);
    const defaultPriority = terminal?.type === 'MATCH'
      ? terminal.priority
      : snapshot.rules.length + 1;
    const draft = {
      name: String(item?.name || item?.pattern || ''),
      displayName: String(item?.displayName || ''),
      type: String(
        item?.type ||
          initialValues?.type ||
          (resource === 'rules'
            ? 'DOMAIN'
            : resource === 'proxy-groups'
              ? 'select'
              : '')
      ),
      configText: JSON.stringify(
        resource === 'proxy-groups'
          ? configWithout((item?.config || {}) as JsonObject, [
              'proxies',
              'use',
              'filter'
            ])
          : item?.config || {},
        null,
        2
      ),
      sourceType: String(item?.sourceType || 'remote'),
      sourceUrl: '',
      sourceHeaders: '',
      clearSource: false,
      clearHeaders: false,
      providerBehavior: String(item?.behavior || 'domain'),
      providerType: String(item?.providerType || 'inline'),
      entriesText: Array.isArray(item?.entries)
        ? (item.entries as Array<{ value: string }>)
            .map((entry) => entry.value)
            .join('\n')
        : '',
      groupProxies: (initialValues?.groupProxies || textArray(config.proxies)).join('\n'),
      groupUse: (initialValues?.groupUse || textArray(config.use)).join('\n'),
      groupFilter: String(config.filter || ''),
      rulePayload: itemType === 'RULE-SET' && !itemPayload
        ? snapshot.ruleProviders[0]?.name || ''
        : itemPayload,
      rulePolicy: String(item?.policy || initialValues?.policy || 'DIRECT'),
      ruleOptions: Array.isArray(item?.options) ? (item.options as string[]) : [],
      ruleEnabled: item?.enabled === undefined ? true : Boolean(item.enabled),
      ruleNote: String(item?.note || ''),
      rulePriority: String(item?.priority || defaultPriority),
      hostPattern: String(item?.pattern || ''),
      hostValue: String(item?.value || '')
    };
    setName(draft.name);
    setDisplayName(draft.displayName);
    setType(draft.type);
    setConfigText(draft.configText);
    setSourceType(draft.sourceType);
    setSourceUrl(draft.sourceUrl);
    setSourceHeaders(draft.sourceHeaders);
    setClearSource(draft.clearSource);
    setClearHeaders(draft.clearHeaders);
    setProviderBehavior(draft.providerBehavior);
    setProviderType(draft.providerType);
    setEntriesText(draft.entriesText);
    setGroupProxies(draft.groupProxies);
    setGroupUse(draft.groupUse);
    setGroupFilter(draft.groupFilter);
    setRulePayload(draft.rulePayload);
    setRulePolicy(draft.rulePolicy);
    setRuleOptions(draft.ruleOptions);
    setRuleEnabled(draft.ruleEnabled);
    setRuleNote(draft.ruleNote);
    setRulePriority(draft.rulePriority);
    setHostPattern(draft.hostPattern);
    setHostValue(draft.hostValue);
    setBaseline(JSON.stringify(draft));
  }

  useEffect(() => {
    if (!open || !resource) return;
    const identity = `${profileId}:${resource}:${existing?.id ?? 'new'}`;
    if (identity === loadedIdentity.current && dirtyRef.current) return;
    resetDraft();
  }, [
    open,
    resource,
    existing,
    initialValues,
    profileId,
    snapshot.rules,
    snapshot.ruleProviders
  ]);

  if (!resource) return null;
  const editingRuleType =
    existing && 'type' in existing ? existing.type : undefined;
  const ruleSetOptions = snapshot.ruleProviders.map((provider) => ({
    value: provider.name,
    label: [
      provider.displayName.trim(),
      provider.name,
      `${provider.behavior} / ${provider.providerType}`
    ]
      .filter(Boolean)
      .join(' · ')
  }));
  if (
    type === 'RULE-SET' &&
    rulePayload &&
    !ruleSetOptions.some((option) => option.value === rulePayload)
  ) {
    ruleSetOptions.unshift({
      value: rulePayload,
      label: `${rulePayload}（规则集不存在）`
    });
  }

  function changeRuleType(nextType: string) {
    setType(nextType);
    if (nextType === 'RULE-SET') {
      if (
        !snapshot.ruleProviders.some(
          (provider) => provider.name === rulePayload
        )
      ) {
        setRulePayload(snapshot.ruleProviders[0]?.name || '');
      }
    } else if (type === 'RULE-SET') {
      setRulePayload('');
    }
  }

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
      if (
        resource === 'rules' &&
        type === 'RULE-SET' &&
        !snapshot.ruleProviders.some(
          (provider) => provider.name === rulePayload
        )
      ) {
        throw new Error('请选择一个已存在的规则集。');
      }
      let body: unknown;
      if (resource === 'proxies') {
        body = {
          name: name.trim(),
          type: type.trim(),
          config: parseObject(configText, '协议配置')
        };
      } else if (resource === 'proxy-providers') {
        body = {
          name: name.trim(),
          config: parseObject(configText, '代理源配置'),
          sourceType,
          ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
          ...(sourceHeaders.trim()
            ? { sourceHeaders: parseObject(sourceHeaders, '认证请求头') }
            : {}),
          clearSource,
          clearHeaders
        };
      } else if (resource === 'proxy-groups') {
        const rest = configWithout(parseObject(configText, '策略组高级配置'), [
          'proxies',
          'use',
          'filter'
        ]);
        body = {
          name: name.trim(),
          type,
          config: {
            ...rest,
            proxies: groupProxies
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean),
            use: groupUse
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean),
            ...(groupFilter.trim() ? { filter: groupFilter.trim() } : {})
          }
        };
      } else if (resource === 'rule-providers') {
        body = {
          name: name.trim(),
          displayName: displayName.trim(),
          behavior: providerBehavior.trim(),
          providerType,
          config: parseObject(configText, '规则集配置'),
          entries: entriesText
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
        };
      } else if (resource === 'rules') {
        body = {
          type,
          payload: rulePayload,
          policy: rulePolicy,
          options: ruleOptions,
          enabled: ruleEnabled,
          note: ruleNote,
          priority: Number(rulePriority)
        };
      } else {
        body = {
          pattern: hostPattern.trim(),
          value: hostValue.trim()
        };
      }

      await apiRequest(
        `/api/profiles/${profileId}/${resource}${
          existing ? `/${(existing as { id: number }).id}` : ''
        }`,
        {
          method: existing ? 'PUT' : 'POST',
          body: JSON.stringify(body),
          token
        }
      );
      dirtyRef.current = false;
      setBaseline(fingerprint);
      await onSaved(existing ? '资源已更新。' : '资源已创建。');
      onOpenChange(false);
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

  const titles: Record<ResourceKind, string> = {
    proxies: '直接节点',
    'proxy-providers': '代理源',
    'proxy-groups': '策略组',
    'rule-providers': '规则集',
    rules: '路由规则',
    hosts: 'Host 映射'
  };

  return (
    <Modal
      open={open}
      onOpenChange={changeOpen}
      title={`${existing ? '编辑' : '新增'}${titles[resource]}`}
      description="选择当前配置中的关联资源，按字段调整参数；保留原文件中未修改的字段。"
      wide
      footer={
        <>
          <button
            className="button secondary"
            onClick={() => changeOpen(false)}
          >
            取消
          </button>
          <button className="button primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-grid" ref={formRoot} inert={saving} aria-busy={saving}>
        {resource === 'hosts' ? (
          <>
            <label className="field wide">
              <span>Hostname / Wildcard</span>
              <input
                className="input"
                value={hostPattern}
                onChange={(event) => setHostPattern(event.target.value)}
                placeholder="*.example.com"
              />
            </label>
            <label className="field wide">
              <span>目标地址</span>
              <input
                className="input"
                value={hostValue}
                onChange={(event) => setHostValue(event.target.value)}
                placeholder="192.0.2.10"
              />
            </label>
          </>
        ) : null}

        {resource === 'proxies' ? (
          <>
            <label className="field">
              <span>节点名称</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>协议类型</span>
              <input
                className="input"
                value={type}
                onChange={(event) => setType(event.target.value)}
                list="stash-protocols"
                placeholder="选择协议或输入其他 Stash 协议标识"
              />
            </label>
            <datalist id="stash-protocols">
              {[
                'ss',
                'vmess',
                'vless',
                'trojan',
                'hysteria',
                'hysteria2',
                'tuic',
                'wireguard',
                'socks5',
                'http'
              ].map((protocol) => (
                <option key={protocol} value={protocol} />
              ))}
            </datalist>
            <ConfigFields
              key={resource}
              label="节点连接参数"
              text={configText}
              onChange={setConfigText}
              suggestions={{ server: '', port: 443, tls: false }}
            />
          </>
        ) : null}

        {resource === 'proxy-providers' ? (
          <>
            <label className="field wide">
              <span>代理源名称</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <SelectField
              label="来源方式"
              value={sourceType}
              onValueChange={setSourceType}
              options={[
                { value: 'remote', label: '远程订阅（加密保存 URL）' },
                { value: 'local', label: 'Stash 本地文件（使用 path）' }
              ]}
              wide
            />
            <label className="field wide">
              <span>私人订阅地址（HTTP/HTTPS）</span>
              <input
                className="input mono"
                type="password"
                autoComplete="new-password"
                disabled={sourceType === 'local' || clearSource}
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder={
                  existing &&
                  'sourceConfigured' in existing &&
                  existing.sourceConfigured
                    ? '已有来源，留空保留；填写新地址可替换'
                    : 'https://…'
                }
              />
              <small>
                加密保存到这个代理源，下载时自动使用；普通 API
                不回传地址。本地文件来源可留空，并在高级参数设置 path。
              </small>
            </label>
            <SwitchField
              label="清除已有订阅地址"
              checked={clearSource}
              onCheckedChange={setClearSource}
              description="清除后远程来源变为待配置；下载仍保留最近成功版本，直到新配置通过检查。"
            />
            <details className="wide">
              <summary>认证请求头与高级来源参数</summary>
              <ConfigFields
                label="替换认证请求头（不编辑则保留）"
                text={sourceHeaders}
                onChange={setSourceHeaders}
              />
              <SwitchField
                label="清除已有请求头"
                checked={clearHeaders}
                onCheckedChange={setClearHeaders}
              />
            </details>
            <ConfigFields
              key={resource}
              label="来源更新与缓存"
              text={configText}
              onChange={setConfigText}
              suggestions={{ path: '', interval: 3600, filter: '' }}
            />
          </>
        ) : null}

        {resource === 'proxy-groups' ? (
          <>
            <label className="field">
              <span>策略组名称</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <SelectField
              label="策略类型"
              value={type || 'select'}
              onValueChange={setType}
              options={[
                { value: 'select', label: 'select / 手动选择' },
                { value: 'url-test', label: 'url-test / 延迟优选' },
                { value: 'fallback', label: 'fallback / 顺序故障转移' },
                { value: 'load-balance', label: 'load-balance / 负载均衡' },
                { value: 'relay', label: 'relay / 链式代理' }
              ]}
            />
            <div className="field wide">
              <span>选择节点与策略组</span>
              <div className="check-row">
                {[
                  ...BUILTIN_POLICIES,
                  ...snapshot.proxies.map((p) => p.name),
                  ...snapshot.proxyGroups
                    .filter((g) => g.id !== existing?.id)
                    .map((g) => g.name)
                ].map((member) => (
                  <label className="check-chip" key={member}>
                    <input
                      type="checkbox"
                      checked={groupProxies.split('\n').includes(member)}
                      onChange={(e) =>
                        setGroupProxies((current) =>
                          e.target.checked
                            ? [
                                ...current.split('\n').filter(Boolean),
                                member
                              ].join('\n')
                            : current
                                .split('\n')
                                .filter((value) => value !== member)
                                .join('\n')
                        )
                      }
                    />
                    {member}
                  </label>
                ))}
              </div>
            </div>
            <div className="field wide">
              <span>选择订阅来源</span>
              <div className="check-row">
                {snapshot.proxyProviders.map((provider) => (
                  <label className="check-chip" key={provider.id}>
                    <input
                      type="checkbox"
                      checked={groupUse.split('\n').includes(provider.name)}
                      onChange={(e) =>
                        setGroupUse((current) =>
                          e.target.checked
                            ? [
                                ...current.split('\n').filter(Boolean),
                                provider.name
                              ].join('\n')
                            : current
                                .split('\n')
                                .filter((v) => v !== provider.name)
                                .join('\n')
                        )
                      }
                    />
                    {provider.name} ·{' '}
                    {provider.sourceConfigured ? '已配置' : '缺少来源'}
                  </label>
                ))}
              </div>
              <small>
                订阅中的节点由 Stash
                加载；此处不把未验证的筛选结果显示为可用节点。
              </small>
            </div>
            <div className="field wide">
              <span>已选出口成员的顺序</span>
              <div className="member-order">
                {groupProxies
                  .split('\n')
                  .filter(Boolean)
                  .map((member, index, list) => (
                    <div key={member + index}>
                      <strong>
                        {index + 1}. {member}
                      </strong>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...list];
                          [next[index - 1], next[index]] = [
                            next[index],
                            next[index - 1]
                          ];
                          setGroupProxies(next.join('\n'));
                        }}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={index === list.length - 1}
                        onClick={() => {
                          const next = [...list];
                          [next[index + 1], next[index]] = [
                            next[index],
                            next[index + 1]
                          ];
                          setGroupProxies(next.join('\n'));
                        }}
                      >
                        下移
                      </button>
                    </div>
                  ))}
              </div>
              <small>
                fallback 按此顺序选择可用出口；select 在 Stash 中由用户选择。
              </small>
            </div>
            <details className="wide">
              <summary>专家模式 · 直接编辑引用标识</summary>
              <div className="form-grid">
                <label className="field">
                  <span>显式成员（每行一个）</span>
                  <textarea
                    className="code-input compact"
                    rows={7}
                    value={groupProxies}
                    onChange={(event) => setGroupProxies(event.target.value)}
                    placeholder={'策略组或节点标识\nDIRECT'}
                  />
                </label>
                <label className="field">
                  <span>代理源引用（每行一个）</span>
                  <textarea
                    className="code-input compact"
                    rows={7}
                    value={groupUse}
                    onChange={(event) => setGroupUse(event.target.value)}
                    placeholder="订阅来源标识"
                  />
                </label>
              </div>
            </details>
            <label className="field wide">
              <span>节点过滤正则</span>
              <input
                className="input mono"
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
                placeholder="可选：按订阅节点名称筛选"
              />
            </label>
            <ConfigFields
              key={resource}
              label="检查与高级策略参数"
              text={configText}
              onChange={setConfigText}
              suggestions={{
                interval: 600,
                tolerance: 100,
                lazy: true,
                hidden: false
              }}
            />
          </>
        ) : null}

        {resource === 'rule-providers' ? (
          <>
            <label className="field">
              <span>Stash 规则集标识</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <small>
                写入 YAML 并供 RULE-SET 引用；修改时会同步更新引用。
              </small>
            </label>
            <label className="field">
              <span>界面显示名称</span>
              <input
                className="input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="例如：办公服务域名"
              />
              <small>
                只保存在管理数据库中，不会导出到 Stash YAML；留空时显示 Stash
                标识。
              </small>
            </label>
            <SelectField
              label="来源类型"
              value={providerType}
              onValueChange={setProviderType}
              options={[
                { value: 'inline', label: 'inline / 数据库条目' },
                { value: 'remote', label: 'remote / 远程 URL' },
                { value: 'local', label: 'local / 本地 path' }
              ]}
            />
            <SelectField
              label="Behavior"
              value={providerBehavior}
              onValueChange={setProviderBehavior}
              options={[
                { value: 'domain', label: 'domain' },
                { value: 'ipcidr', label: 'ipcidr' },
                { value: 'classical', label: 'classical' }
              ]}
            />
            <label className="field wide">
              <span>Inline 条目（每行一个）</span>
              <textarea
                className="code-input"
                rows={10}
                value={entriesText}
                onChange={(event) => setEntriesText(event.target.value)}
                placeholder={'+.example.com\nexample.org'}
                disabled={providerType !== 'inline'}
              />
            </label>
            <ConfigFields
              key={resource}
              label="规则集来源与更新"
              text={configText}
              onChange={setConfigText}
              suggestions={{
                url: '',
                path: '',
                format: 'yaml',
                interval: 86400
              }}
            />
          </>
        ) : null}

        {resource === 'rules' ? (
          <>
            <SelectField
              label="规则类型"
              value={type || 'DOMAIN'}
              onValueChange={changeRuleType}
              options={RULE_TYPES.map((item) => ({
                value: item,
                label: item,
                description: RULE_TYPE_DESCRIPTIONS[item]
              }))}
              disabled={editingRuleType === 'MATCH'}
            />
            <SelectField
              label="策略 / 目标组"
              value={rulePolicy}
              onValueChange={setRulePolicy}
              options={policyOptions}
            />
            {type === 'RULE-SET' ? (
              snapshot.ruleProviders.length ? (
                <SelectField
                  label="匹配规则集"
                  value={rulePayload}
                  onValueChange={setRulePayload}
                  options={ruleSetOptions}
                  wide
                />
              ) : (
                <div className="empty-state compact wide">
                  <strong>尚无可用规则集</strong>
                  <span>请先创建规则集，再新增 RULE-SET 路由规则。</span>
                </div>
              )
            ) : (
              <label className="field wide">
                <span>匹配内容</span>
                <textarea
                  className="code-input compact"
                  rows={4}
                  value={rulePayload}
                  onChange={(event) => setRulePayload(event.target.value)}
                  disabled={type === 'MATCH'}
                  placeholder="DOMAIN-SUFFIX 填 example.com；逻辑规则填 ((...))"
                />
              </label>
            )}
            <label className="field">
              <span>优先级</span>
              <input
                className="input mono"
                type="number"
                min={1}
                value={rulePriority}
                onChange={(event) => setRulePriority(event.target.value)}
                disabled={editingRuleType === 'MATCH'}
              />
            </label>
            <div className="field">
              <span>选项</span>
              <div className="check-row">
                {RULE_OPTIONS.map((option) => (
                  <label className="check-chip" key={option}>
                    <input
                      type="checkbox"
                      checked={ruleOptions.includes(option)}
                      onChange={(event) =>
                        setRuleOptions((current) =>
                          event.target.checked
                            ? [...current, option]
                            : current.filter((item) => item !== option)
                        )
                      }
                      disabled={type === 'MATCH'}
                    />
                    {option}
                  </label>
                ))}
              </div>
            </div>
            <label className="field wide">
              <span>备注</span>
              <input
                className="input"
                value={ruleNote}
                maxLength={500}
                onChange={(event) => setRuleNote(event.target.value)}
              />
            </label>
            <div className="wide">
              <SwitchField
                label="启用此规则"
                checked={ruleEnabled}
                onCheckedChange={setRuleEnabled}
                disabled={type === 'MATCH' && ruleEnabled}
                description={type === 'MATCH'
                  ? 'MATCH 必须启用并位于末尾；保存时会自动修复位置。'
                  : '停用状态只影响数据库导出，不写入 Stash YAML。'}
              />
            </div>
          </>
        ) : null}
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </Modal>
  );
}
