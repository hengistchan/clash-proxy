'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { ProxyProvider } from '@/lib/types';
import { ConfigFields } from './config-fields';
import { SelectField } from './ui';

type TextChange = (text: string) => void;
type BoolChange = (checked: boolean) => void;

export function ProxyGroupFields({
  name, setName, configText, setConfigText, type, setType,
  groupProxies, setGroupProxies, groupUse, setGroupUse, groupFilter, setGroupFilter,
  groupExcludeFilter, setGroupExcludeFilter, groupExcludeType, setGroupExcludeType,
  groupPolicyPriority, setGroupPolicyPriority,
  groupIncludeAll, setGroupIncludeAll,
  groupIncludeAllProxies, setGroupIncludeAllProxies,
  groupIncludeAllProviders, setGroupIncludeAllProviders,
  groupHidden, setGroupHidden,
  groupBenchmarkDisabled, setGroupBenchmarkDisabled,
  stashText, setStashText, shadowrocketText, setShadowrocketText, memberOptions, directNodeNames, providers
}: {
  name: string; setName: TextChange; configText: string; setConfigText: TextChange;
  type: string; setType: TextChange; groupProxies: string; setGroupProxies: Dispatch<SetStateAction<string>>;
  groupUse: string; setGroupUse: Dispatch<SetStateAction<string>>; groupFilter: string; setGroupFilter: TextChange;
  groupExcludeFilter: string; setGroupExcludeFilter: TextChange;
  groupExcludeType: string; setGroupExcludeType: TextChange;
  groupPolicyPriority: string; setGroupPolicyPriority: TextChange;
  groupIncludeAll: boolean; setGroupIncludeAll: BoolChange;
  groupIncludeAllProxies: boolean; setGroupIncludeAllProxies: BoolChange;
  groupIncludeAllProviders: boolean; setGroupIncludeAllProviders: BoolChange;
  groupHidden: boolean; setGroupHidden: BoolChange;
  groupBenchmarkDisabled: boolean; setGroupBenchmarkDisabled: BoolChange;
  stashText: string; setStashText: TextChange; shadowrocketText: string; setShadowrocketText: TextChange;
  memberOptions: string[]; directNodeNames: string[]; providers: Array<Pick<ProxyProvider, 'id' | 'name' | 'sourceConfigured'>>;
}) {
  const isSmart = type === 'smart';
  const selectedMembers = groupProxies.split('\n').filter(Boolean);
  const selectableMembers = isSmart
    ? [...new Set([...directNodeNames, ...selectedMembers])]
    : memberOptions;

  return (
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
          { value: 'smart', label: 'smart / 智能优选（Stash 5.1+）' },
          { value: 'url-test', label: 'url-test / 延迟优选' },
          { value: 'fallback', label: 'fallback / 顺序故障转移' },
          { value: 'load-balance', label: 'load-balance / 负载均衡' },
          { value: 'relay', label: 'relay / 链式代理' }
        ]}
      />
      {isSmart ? (
        <div className="field wide">
          <small>
            Stash 5.1+ Smart 策略组按真实流量表现分站点、分网络环境自动选路，仅可包含实际代理节点（不能嵌套子策略组或 DIRECT / REJECT），且不支持手动固定节点；导出标准 Mihomo 时会自动降级为 url-test 并移除 policy-priority。
          </small>
        </div>
      ) : null}
      <div className="field wide">
        <span>{isSmart ? '选择直接节点（Smart 仅允许实际节点）' : '选择节点与策略组'}</span>
        <div className="check-row">
          {selectableMembers.map((member) => (
            <label className="check-chip" key={member}>
              <input
                type="checkbox"
                checked={selectedMembers.includes(member)}
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
          {providers.map((provider) => (
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
        <span>自动纳入与显示选项（Stash 5.1+）</span>
        <div className="check-row">
          <label className="check-chip">
            <input
              type="checkbox"
              checked={groupIncludeAll}
              onChange={(e) => setGroupIncludeAll(e.target.checked)}
            />
            include-all · 全部节点与代理源
          </label>
          <label className="check-chip">
            <input
              type="checkbox"
              checked={groupIncludeAllProxies}
              onChange={(e) => setGroupIncludeAllProxies(e.target.checked)}
            />
            include-all-proxies · 全部直接节点
          </label>
          <label className="check-chip">
            <input
              type="checkbox"
              checked={groupIncludeAllProviders}
              onChange={(e) => setGroupIncludeAllProviders(e.target.checked)}
            />
            include-all-providers · 全部代理源
          </label>
          <label className="check-chip">
            <input
              type="checkbox"
              checked={groupHidden}
              onChange={(e) => setGroupHidden(e.target.checked)}
            />
            hidden · 隐藏策略组
          </label>
          {isSmart || type === 'relay' || groupBenchmarkDisabled ? (
            <label className="check-chip">
              <input
                type="checkbox"
                checked={groupBenchmarkDisabled}
                onChange={(e) => setGroupBenchmarkDisabled(e.target.checked)}
              />
              benchmark-disabled · 关闭后台探测
            </label>
          ) : null}
        </div>
      </div>
      <div className="field wide">
        <span>已选出口成员的顺序</span>
        <div className="member-order">
          {selectedMembers.map((member, index, list) => (
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
          {isSmart
            ? 'Smart 组内同一层级按配置顺序作为初始顺序；可通过下方 policy-priority 微调节点权重。'
            : 'fallback 按此顺序选择可用出口；select 在 Stash 中由用户选择。'}
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
              placeholder={isSmart ? '仅填直接节点标识' : '策略组或节点标识\nDIRECT'}
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
        <span>节点过滤正则（filter）</span>
        <input
          className="input mono"
          value={groupFilter}
          onChange={(event) => setGroupFilter(event.target.value)}
          placeholder="可选：按订阅/引入节点名称筛选，多条正则用反引号 ` 分隔，如 HK|香港`JP|日本"
        />
      </label>
      <label className="field">
        <span>排除节点正则（exclude-filter · 5.1+）</span>
        <input
          className="input mono"
          value={groupExcludeFilter}
          onChange={(event) => setGroupExcludeFilter(event.target.value)}
          placeholder="可选：官网`流量`到期`剩余"
        />
      </label>
      <label className="field">
        <span>排除协议类型（exclude-type · 5.1+）</span>
        <input
          className="input mono"
          value={groupExcludeType}
          onChange={(event) => setGroupExcludeType(event.target.value)}
          placeholder="可选：完整协议名，如 Shadowsocks|VMess"
        />
      </label>
      {isSmart || groupPolicyPriority ? (
        <label className="field wide">
          <span>Smart 策略权重（policy-priority · Stash 5.1+）</span>
          <input
            className="input mono"
            value={groupPolicyPriority}
            onChange={(event) => setGroupPolicyPriority(event.target.value)}
            placeholder="例如：Premium:0.7;HK|香港:0.85;x3:1.5"
          />
          <small>
            格式为 正则:权重，多条用英文分号 ; 分隔。默认权重 1，数值越小越优先（&lt;1 提权，&gt;1 降权），区分大小写且按顺序命中第一条。
          </small>
        </label>
      ) : null}
      <ConfigFields
        label="通用测速与显示参数"
        text={configText}
        onChange={setConfigText}
        suggestions={
          isSmart
            ? { 'benchmark-url': 'http://www.gstatic.com/generate_204', 'benchmark-timeout': 5 }
            : { interval: 600, tolerance: 100 }
        }
      />
      <ConfigFields
        label="Stash 专用参数"
        text={stashText}
        onChange={setStashText}
        suggestions={isSmart ? { 'use-url': '' } : { lazy: true, 'ssid-policy': {} }}
      />
      <ConfigFields label="Shadowrocket 专用参数" text={shadowrocketText} onChange={setShadowrocketText}
        suggestions={{ 'policy-regex-filter': '', 'policy-select-name': '', select: 0, use: false, nativeMembers: [] }} />
    </>
  );
}
