'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  HostEntry,
  JsonObject,
  ProxyGroup,
  ProxyNode,
  ProxyProvider,
  ProxyRewriteRule,
  ResourceKind,
  RuleProvider,
  Snapshot,
  StashRule
} from '@/lib/types';
import { splitClientFields } from '@/lib/config-client-fields';
import { BUILTIN_POLICIES, SHADOWROCKET_BUILTINS } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';
import { Modal } from './ui';
import type { EditorPreset } from './relationships-view';
import { HostEditorFields, NodeEditorFields, RuleEditorFields } from './resource-editor-fields';
import { ProxyProviderFields } from './proxy-provider-fields';
import { ProxyGroupFields } from './proxy-group-fields';
import { RuleProviderFields } from './rule-provider-fields';
import { ProxySourceRewrites } from './proxy-source-rewrites';
import { useUnsavedChanges } from './unsaved-changes';
import {
  PROXY_GROUP_TYPE_DESCRIPTIONS,
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

function snapshotResources(snapshot: Snapshot, resource: ResourceKind) {
  return {
    proxies: snapshot.proxies, 'proxy-providers': snapshot.proxyProviders,
    'proxy-groups': snapshot.proxyGroups, 'rule-providers': snapshot.ruleProviders,
    rules: snapshot.rules, hosts: snapshot.hosts
  }[resource];
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
  const [stashText, setStashText] = useState('{}');
  const [shadowrocketText, setShadowrocketText] = useState('{}');
  const [shadowrocketSourceUrl, setShadowrocketSourceUrl] = useState('');
  const [clearShadowrocketSource, setClearShadowrocketSource] = useState(false);
  const [sourceType, setSourceType] = useState('remote');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceHeaders, setSourceHeaders] = useState('');
  const [clearSource, setClearSource] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [rewriteRules, setRewriteRules] = useState<ProxyRewriteRule[]>([]);
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
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(snapshot.profile.revision);
  const fingerprint = JSON.stringify({
    name, displayName, type, configText, stashText, shadowrocketText, shadowrocketSourceUrl, clearShadowrocketSource, sourceType, sourceUrl, sourceHeaders,
    clearSource, clearHeaders, rewriteRules, providerBehavior, providerType, entriesText,
    groupProxies, groupUse, groupFilter, rulePayload, rulePolicy, ruleOptions,
    ruleEnabled, ruleNote, rulePriority, hostPattern, hostValue
  });
  const dirty = baseline !== null && fingerprint !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedIdentity = useRef('');
  const { confirmDiscard } = useUnsavedChanges(open && dirty, open && saving, resetDraft);

  async function changeOpen(next: boolean) {
    if (next || (await confirmDiscard())) onOpenChange(next);
  }

  const policyOptions = useMemo(
    () => [
      ...BUILTIN_POLICIES.map((item) => ({
        value: item,
        label: item,
        description: builtinPolicyDescription(item)
      })),
      ...(snapshot.profile.clientOptions?.shadowrocket?.native === true
        ? SHADOWROCKET_BUILTINS.filter((name) => ![...snapshot.proxies, ...snapshot.proxyGroups].some((item) => item.name === name))
            .map((name) => ({ value: name, label: name, description: 'Shadowrocket 内置策略' }))
        : []),
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

  function proxySourceDraft() {
    return {
      config: parseObject(configText, '代理源配置'),
      ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      ...(sourceHeaders.trim() ? { sourceHeaders: parseObject(sourceHeaders, '认证请求头') } : {}),
      clearSource,
      clearHeaders
    };
  }

  function resetDraft() {
    if (!resource) return;
    dirtyRef.current = false;
    const identity = `${profileId}:${resource}:${existing?.id ?? 'new'}`;
    loadedIdentity.current = identity;
    setDraftRevision(snapshot.profile.revision);
    setError('');
    setRevisionConflict(false);
    const latest = existing ? snapshotResources(snapshot, resource).find((entry) => entry.id === existing.id) : null;
    if (existing && !latest) setError('该资源已被其他会话删除或由导入替换。请关闭编辑器并从最新列表重新打开资源。');
    const item = (latest || existing) as Record<string, unknown> | null;
    const config = (item?.config || {}) as JsonObject;
    const scoped = resource === 'proxy-groups' || resource === 'rule-providers';
    const separated = scoped ? splitClientFields(resource, config) : { common: config, stash: {} };
    const clients = item?.clientOptions as { shadowrocket?: JsonObject } | undefined;
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
        resource === 'proxy-groups' ? configWithout(separated.common, ['proxies', 'use', 'filter']) : separated.common,
        null, 2
      ),
      stashText: JSON.stringify(configWithout(separated.stash, resource === 'rule-providers' ? ['type', 'payload', 'behavior'] : []), null, 2),
      shadowrocketText: JSON.stringify(scoped ? clients?.shadowrocket ?? {} : {}, null, 2),
      shadowrocketSourceUrl: '',
      clearShadowrocketSource: false,
      sourceType: String(item?.sourceType || 'remote'),
      sourceUrl: '',
      sourceHeaders: '',
      clearSource: false,
      clearHeaders: false,
      rewriteRules: (item?.rewriteRules as ProxyRewriteRule[] | undefined) ?? [],
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
    setStashText(draft.stashText);
    setShadowrocketText(draft.shadowrocketText);
    setShadowrocketSourceUrl(draft.shadowrocketSourceUrl);
    setClearShadowrocketSource(draft.clearShadowrocketSource);
    setSourceType(draft.sourceType);
    setSourceUrl(draft.sourceUrl);
    setSourceHeaders(draft.sourceHeaders);
    setClearSource(draft.clearSource);
    setClearHeaders(draft.clearHeaders);
    setRewriteRules(draft.rewriteRules);
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
    snapshot.ruleProviders,
    snapshot.profile.revision
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

  function changeProviderType(next: string) {
    try {
      const config = parseObject(configText, '规则集配置');
      ['type', 'payload', 'behavior'].forEach((key) => delete config[key]);
      if (next === 'inline') ['url', 'path', 'format', 'interval', 'headers'].forEach((key) => delete config[key]);
      if (next === 'local') ['url', 'headers', 'interval'].forEach((key) => delete config[key]);
      setConfigText(JSON.stringify(config, null, 2));
      setProviderType(next);
      setSourceUrl('');
      setSourceHeaders('');
    } catch { setError('请先修复规则集配置，再切换来源类型。'); }
  }

  const missingResource = Boolean(resource && existing && !snapshotResources(snapshot, resource).some((entry) => entry.id === existing.id));

  async function discardAndReload() {
    if (saving || !(await confirmDiscard())) return;
    setSaving(true);
    try {
      await onSaved('已读取最新快照，请重新打开资源后编辑。');
      dirtyRef.current = false;
      setBaseline(fingerprint);
      setRevisionConflict(false);
      onOpenChange(false);
    } finally { setSaving(false); }
  }

  async function save() {
    if (saving) return;
    if (missingResource) {
      setError('该资源已被删除或替换。请关闭编辑器并重新打开最新资源。');
      return;
    }
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
          ...proxySourceDraft(),
          sourceType,
          ...(sourceType === 'remote' ? { rewriteRules } : {})
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
          clientOptions: { shadowrocket: parseObject(shadowrocketText, 'Shadowrocket 专用参数') },
          config: {
            ...configWithout(parseObject(stashText, 'Stash 专用参数'), ['proxies', 'use', 'filter']),
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
        const native = providerType === 'inline' ? {} : parseObject(shadowrocketText, 'Shadowrocket 专用参数');
        body = {
          name: name.trim(),
          displayName: displayName.trim(),
          behavior: providerBehavior.trim(),
          providerType,
          config: { ...parseObject(stashText, 'Stash 专用参数'), ...parseObject(configText, '规则集配置') },
          clientOptions: { shadowrocket: native },
          ...(providerType === 'remote' && native.referenceType && shadowrocketSourceUrl.trim() && !clearShadowrocketSource
            ? { shadowrocketSourceUrl: shadowrocketSourceUrl.trim() } : {}),
          clearShadowrocketSource,
          ...(providerType === 'remote' && sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
          ...(providerType === 'remote' && sourceHeaders.trim() ? { sourceHeaders: parseObject(sourceHeaders, '认证请求头') } : {}),
          clearSource,
          clearHeaders,
          entries: providerType !== 'inline' ? [] : entriesText
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
          expectedRevision: draftRevision,
          body: JSON.stringify(body),
          token
        }
      );
      dirtyRef.current = false;
      setBaseline(fingerprint);
      await onSaved(existing ? '资源已更新。' : '资源已创建。');
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'revision.conflict') setRevisionConflict(true);
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
          {revisionConflict || missingResource ? <button className="button secondary" disabled={saving} onClick={() => void discardAndReload()}>放弃并读取最新配置</button> : null}
          <button className="button primary" disabled={saving || missingResource} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-grid" ref={formRoot} inert={saving} aria-busy={saving}>
        {resource === 'hosts' ? <HostEditorFields hostPattern={hostPattern} setHostPattern={setHostPattern} hostValue={hostValue} setHostValue={setHostValue} /> : null}

        {resource === 'proxies' ? <NodeEditorFields name={name} setName={setName} type={type} setType={setType} configText={configText} setConfigText={setConfigText} /> : null}

        {resource === 'proxy-providers' ? (
          <ProxyProviderFields
            name={name} setName={setName} configText={configText}
            setConfigText={setConfigText} sourceUrl={sourceUrl} setSourceUrl={setSourceUrl}
            sourceHeaders={sourceHeaders} setSourceHeaders={setSourceHeaders} clearSource={clearSource}
            setClearSource={setClearSource} clearHeaders={clearHeaders} setClearHeaders={setClearHeaders}
            sourceType={sourceType} setSourceType={setSourceType} sourceConfigured={Boolean((existing as ProxyProvider | null)?.sourceConfigured)}
            rewrites={<ProxySourceRewrites
                rules={rewriteRules} onChange={setRewriteRules}
                sourceKey={JSON.stringify([profileId, existing?.id, draftRevision, configText, sourceUrl, sourceHeaders, clearSource, clearHeaders])}
                onPreview={signal => apiRequest(`/api/profiles/${profileId}/proxy-source-preview`, {
                  method: 'POST', token, signal,
                  body: JSON.stringify({ ...proxySourceDraft(), providerId: existing?.id, rewriteRules })
                })}
              />}
          />
        ) : null}

        {resource === 'proxy-groups' ? (
          <ProxyGroupFields
            name={name} setName={setName} configText={configText}
            setConfigText={setConfigText} type={type} setType={setType}
            groupProxies={groupProxies} setGroupProxies={setGroupProxies} groupUse={groupUse}
            setGroupUse={setGroupUse} groupFilter={groupFilter} setGroupFilter={setGroupFilter}
            stashText={stashText} setStashText={setStashText} shadowrocketText={shadowrocketText}
            setShadowrocketText={setShadowrocketText} memberOptions={[...BUILTIN_POLICIES, ...snapshot.proxies.map(node => node.name),
              ...snapshot.proxyGroups.filter(group => group.id !== existing?.id).map(group => group.name)]} providers={snapshot.proxyProviders}
          />
        ) : null}

        {resource === 'rule-providers' ? (
          <RuleProviderFields
            name={name} setName={setName} configText={configText}
            setConfigText={setConfigText} sourceUrl={sourceUrl} setSourceUrl={setSourceUrl}
            sourceHeaders={sourceHeaders} setSourceHeaders={setSourceHeaders} clearSource={clearSource}
            setClearSource={setClearSource} clearHeaders={clearHeaders} setClearHeaders={setClearHeaders}
            provider={existing as RuleProvider | null} displayName={displayName} setDisplayName={setDisplayName}
            providerType={providerType} changeProviderType={changeProviderType} providerBehavior={providerBehavior}
            setProviderBehavior={setProviderBehavior} entriesText={entriesText} setEntriesText={setEntriesText}
            stashText={stashText} setStashText={setStashText} referenceType={providerType === 'inline' ? 'shared' : String(parseObject(shadowrocketText, 'Shadowrocket 专用参数').referenceType || 'shared')}
            setShadowrocketText={setShadowrocketText} shadowrocketSourceUrl={shadowrocketSourceUrl} setShadowrocketSourceUrl={setShadowrocketSourceUrl}
            clearShadowrocketSource={clearShadowrocketSource} setClearShadowrocketSource={setClearShadowrocketSource}
          />
        ) : null}

        {resource === 'rules' ? <RuleEditorFields type={type} changeRuleType={changeRuleType} editingRuleType={editingRuleType} rulePolicy={rulePolicy} setRulePolicy={setRulePolicy} policyOptions={policyOptions} ruleSetOptions={ruleSetOptions} rulePayload={rulePayload} setRulePayload={setRulePayload} rulePriority={rulePriority} setRulePriority={setRulePriority} ruleOptions={ruleOptions} setRuleOptions={setRuleOptions} ruleNote={ruleNote} setRuleNote={setRuleNote} ruleEnabled={ruleEnabled} setRuleEnabled={setRuleEnabled} hasRuleProviders={snapshot.ruleProviders.length > 0} /> : null}
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </Modal>
  );
}
