'use client';

import { useEffect, useMemo, useState } from 'react';

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

function configWithout(
  config: JsonObject,
  keys: string[]
): JsonObject {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !keys.includes(key))
  ) as JsonObject;
}

export function EditorDialog({
  open,
  onOpenChange,
  resource,
  existing,
  snapshot,
  profileId,
  token,
  onSaved
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ResourceKind | null;
  existing: EditableResource;
  snapshot: Snapshot;
  profileId: number;
  token: string;
  onSaved: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [configText, setConfigText] = useState('{}');
  const [requiresUrl, setRequiresUrl] = useState(false);
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

  const policyNames = useMemo(
    () => [
      ...BUILTIN_POLICIES,
      ...snapshot.proxies.map((item) => item.name),
      ...snapshot.proxyGroups.map((item) => item.name)
    ],
    [snapshot]
  );

  useEffect(() => {
    if (!open || !resource) return;
    setError('');
    const item = existing as Record<string, unknown> | null;
    setName(String(item?.name || item?.pattern || ''));
    setType(
      String(
        item?.type ||
          (resource === 'rules'
            ? 'DOMAIN'
            : resource === 'proxy-groups'
              ? 'select'
              : '')
      )
    );
    setConfigText(JSON.stringify(item?.config || {}, null, 2));
    setRequiresUrl(Boolean(item?.requiresUrl));
    setProviderBehavior(String(item?.behavior || 'domain'));
    setProviderType(String(item?.providerType || 'inline'));
    setEntriesText(
      Array.isArray(item?.entries)
        ? (item.entries as Array<{ value: string }>).map((entry) => entry.value).join('\n')
        : ''
    );
    const config = (item?.config || {}) as JsonObject;
    setGroupProxies(textArray(config.proxies).join('\n'));
    setGroupUse(textArray(config.use).join('\n'));
    setGroupFilter(String(config.filter || ''));
    const itemType = String(item?.type || '');
    const itemPayload = String(item?.payload || '');
    setRulePayload(
      itemType === 'RULE-SET' && !itemPayload
        ? snapshot.ruleProviders[0]?.name || ''
        : itemPayload
    );
    setRulePolicy(String(item?.policy || 'DIRECT'));
    setRuleOptions(Array.isArray(item?.options) ? (item.options as string[]) : []);
    setRuleEnabled(item?.enabled === undefined ? true : Boolean(item.enabled));
    setRuleNote(String(item?.note || ''));
    const terminal = snapshot.rules.at(-1);
    setRulePriority(String(item?.priority || terminal?.priority || 1));
    setHostPattern(String(item?.pattern || ''));
    setHostValue(String(item?.value || ''));
  }, [open, resource, existing, snapshot.rules, snapshot.ruleProviders]);

  if (!resource) return null;
  const editingRuleType = existing && 'type' in existing ? existing.type : undefined;
  const ruleSetOptions = snapshot.ruleProviders.map((provider) => ({
    value: provider.name,
    label: `${provider.name} · ${provider.behavior} / ${provider.providerType}`
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
      if (!snapshot.ruleProviders.some((provider) => provider.name === rulePayload)) {
        setRulePayload(snapshot.ruleProviders[0]?.name || '');
      }
    } else if (type === 'RULE-SET') {
      setRulePayload('');
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (
        resource === 'rules' &&
        type === 'RULE-SET' &&
        !snapshot.ruleProviders.some((provider) => provider.name === rulePayload)
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
          requiresUrl
        };
      } else if (resource === 'proxy-groups') {
        const rest = configWithout(
          parseObject(configText, '策略组高级配置'),
          ['proxies', 'use', 'filter']
        );
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
      onOpenChange={onOpenChange}
      title={`${existing ? '编辑' : '新增'}${titles[resource]}`}
      description="字段保存为类型专属配置；高级 JSON 会原样写回 YAML。"
      wide
      footer={
        <>
          <button className="button secondary" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button className="button primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="form-grid">
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
                placeholder="ss / vmess / trojan / wireguard"
              />
            </label>
            <label className="field wide">
              <span>协议配置 JSON</span>
              <textarea
                className="code-input"
                rows={12}
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
              />
              <small>server、port、凭据、TLS、传输层等字段写入此处。</small>
            </label>
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
            <div className="wide">
              <SwitchField
                label="导出时注入私人订阅 URL"
                checked={requiresUrl}
                onCheckedChange={setRequiresUrl}
                description="启用后 URL 不进入 SQLite，只在生成配置时从请求提交。"
              />
            </div>
            <label className="field wide">
              <span>代理源配置 JSON</span>
              <textarea
                className="code-input"
                rows={11}
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
              />
            </label>
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
            <label className="field">
              <span>显式成员（每行一个）</span>
              <textarea
                className="code-input compact"
                rows={7}
                value={groupProxies}
                onChange={(event) => setGroupProxies(event.target.value)}
                placeholder={'⚡ 自動選優\nDIRECT'}
              />
            </label>
            <label className="field">
              <span>代理源引用（每行一个）</span>
              <textarea
                className="code-input compact"
                rows={7}
                value={groupUse}
                onChange={(event) => setGroupUse(event.target.value)}
                placeholder="GLaDOS"
              />
            </label>
            <label className="field wide">
              <span>节点过滤正则</span>
              <input
                className="input mono"
                value={groupFilter}
                onChange={(event) => setGroupFilter(event.target.value)}
                placeholder="^US-Fixed-[0-9]+$"
              />
            </label>
            <label className="field wide">
              <span>其他策略组字段 JSON</span>
              <textarea
                className="code-input"
                rows={7}
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
              />
              <small>interval、url、tolerance、lazy、hidden、icon、ssid-policy 等。</small>
            </label>
          </>
        ) : null}

        {resource === 'rule-providers' ? (
          <>
            <label className="field">
              <span>规则集名称</span>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
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
            <label className="field wide">
              <span>规则集 Provider JSON</span>
              <textarea
                className="code-input"
                rows={7}
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
              />
              <small>url、path、format、interval、headers 等。</small>
            </label>
          </>
        ) : null}

        {resource === 'rules' ? (
          <>
            <SelectField
              label="规则类型"
              value={type || 'DOMAIN'}
              onValueChange={changeRuleType}
              options={RULE_TYPES.map((item) => ({ value: item, label: item }))}
              disabled={editingRuleType === 'MATCH'}
            />
            <SelectField
              label="策略 / 目标组"
              value={rulePolicy}
              onValueChange={setRulePolicy}
              options={policyNames.map((item) => ({ value: item, label: item }))}
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
                description="停用状态只影响数据库导出，不写入 Stash YAML。"
              />
            </div>
          </>
        ) : null}
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </Modal>
  );
}
