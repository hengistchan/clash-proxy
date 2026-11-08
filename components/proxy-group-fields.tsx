'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { ProxyProvider } from '@/lib/types';
import { ConfigFields } from './config-fields';
import { SelectField } from './ui';

type TextChange = (text: string) => void;

export function ProxyGroupFields({
  name, setName, configText, setConfigText, type, setType,
  groupProxies, setGroupProxies, groupUse, setGroupUse, groupFilter, setGroupFilter,
  stashText, setStashText, shadowrocketText, setShadowrocketText, memberOptions, providers
}: {
  name: string; setName: TextChange; configText: string; setConfigText: TextChange;
  type: string; setType: TextChange; groupProxies: string; setGroupProxies: Dispatch<SetStateAction<string>>;
  groupUse: string; setGroupUse: Dispatch<SetStateAction<string>>; groupFilter: string; setGroupFilter: TextChange;
  stashText: string; setStashText: TextChange; shadowrocketText: string; setShadowrocketText: TextChange;
  memberOptions: string[]; providers: Array<Pick<ProxyProvider, 'id' | 'name' | 'sourceConfigured'>>;
}) {
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
          { value: 'url-test', label: 'url-test / 延迟优选' },
          { value: 'fallback', label: 'fallback / 顺序故障转移' },
          { value: 'load-balance', label: 'load-balance / 负载均衡' },
          { value: 'relay', label: 'relay / 链式代理' }
        ]}
      />
      <div className="field wide">
        <span>选择节点与策略组</span>
        <div className="check-row">
          {memberOptions.map((member) => (
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
        label="通用测速与显示参数"
        text={configText}
        onChange={setConfigText}
        suggestions={{
          interval: 600,
          tolerance: 100,
          hidden: false
        }}
      />
      <ConfigFields label="Stash 专用参数" text={stashText} onChange={setStashText}
        suggestions={{ lazy: true, 'ssid-policy': {} }} />
      <ConfigFields label="Shadowrocket 专用参数" text={shadowrocketText} onChange={setShadowrocketText}
        suggestions={{ 'policy-regex-filter': '', 'policy-select-name': '', select: 0, use: false, nativeMembers: [] }} />
    </>
  );
}
