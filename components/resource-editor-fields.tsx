'use client';

import type { Dispatch, SetStateAction } from 'react';
import { ConfigFields } from './config-fields';
import { SelectField, SwitchField } from './ui';
import { RULE_OPTIONS, RULE_TYPES } from '@/lib/types';
import { RULE_TYPE_DESCRIPTIONS } from '@/lib/rule-metadata';

type TextChange = (text: string) => void;
type Option = { value: string; label: string; description?: string };

export function HostEditorFields({ hostPattern, setHostPattern, hostValue, setHostValue }: {
  hostPattern: string; setHostPattern: TextChange; hostValue: string; setHostValue: TextChange;
}) {
  return (
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
  );
}

export function NodeEditorFields({ name, setName, type, setType, configText, setConfigText }: {
  name: string; setName: TextChange; type: string; setType: TextChange; configText: string; setConfigText: TextChange;
}) {
  return (
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
              label="节点连接参数"
              text={configText}
              onChange={setConfigText}
              suggestions={{ server: '', port: 443, tls: false }}
            />
          </>
  );
}

export function RuleEditorFields({ type, changeRuleType, editingRuleType, rulePolicy, setRulePolicy, policyOptions, ruleSetOptions, rulePayload, setRulePayload, rulePriority, setRulePriority, ruleOptions, setRuleOptions, ruleNote, setRuleNote, ruleEnabled, setRuleEnabled, hasRuleProviders }: {
  type: string; changeRuleType: TextChange; editingRuleType?: string; rulePolicy: string; setRulePolicy: TextChange;
  policyOptions: Option[]; ruleSetOptions: Option[]; rulePayload: string; setRulePayload: TextChange;
  rulePriority: string; setRulePriority: TextChange; ruleOptions: string[]; setRuleOptions: Dispatch<SetStateAction<string[]>>;
  ruleNote: string; setRuleNote: TextChange; ruleEnabled: boolean; setRuleEnabled: (enabled: boolean) => void; hasRuleProviders: boolean;
}) {
  return (
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
              hasRuleProviders ? (
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
  );
}
