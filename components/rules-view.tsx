'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  LockKeyhole,
  Network,
  Plus,
  Search,
  ShieldAlert,
  Trash2
} from 'lucide-react';

import type { Snapshot, StashRule, ValidationResult } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';
import { StatusBadge, SwitchField } from './ui';
import { RoutingSimulator } from './routing-simulator';
import { useUnsavedChanges } from './unsaved-changes';

function ruleBody(rule: StashRule, patch: Partial<StashRule> = {}) {
  const next = { ...rule, ...patch };
  return {
    type: next.type,
    payload: next.payload,
    policy: next.policy,
    options: next.options,
    enabled: next.enabled,
    note: next.note,
    priority: next.priority
  };
}

export function RulesView({
  snapshot,
  validation,
  profileId,
  token,
  onAdd,
  onInspect,
  onEdit,
  onChanged
}: {
  snapshot: Snapshot;
  validation: ValidationResult;
  profileId: number;
  token: string;
  onAdd: () => void;
  onInspect: (rule: StashRule) => void;
  onEdit: (rule: StashRule) => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const mutationLock = useRef(false);
  useUnsavedChanges(false, busy !== null);
  const matchCount = snapshot.rules.filter((rule) => rule.type === 'MATCH').length;
  const lastMovableIndex = snapshot.rules.length - (
    snapshot.rules.at(-1)?.type === 'MATCH' ? 2 : 1
  );

  function beginMutation(id: number): boolean {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    setBusy(id);
    setError('');
    return true;
  }

  function finishMutation() {
    mutationLock.current = false;
    setBusy(null);
  }

  const issuesByRule = useMemo(() => {
    const map = new Map<number, ValidationResult['issues']>();
    validation.issues
      .filter((issue) => issue.resource === 'rule' && issue.resourceId)
      .forEach((issue) => {
        const list = map.get(issue.resourceId!) || [];
        list.push(issue);
        map.set(issue.resourceId!, list);
      });
    return map;
  }, [validation]);

  const rules = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snapshot.rules;
    return snapshot.rules.filter((rule) =>
      [rule.type, rule.payload, rule.policy, rule.note, ...rule.options]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [query, snapshot.rules]);

  async function toggle(rule: StashRule, enabled: boolean) {
    if (rule.type === 'MATCH' && (!enabled || rule.enabled)) return;
    if (!beginMutation(rule.id)) return;
    try {
      await apiRequest(`/api/profiles/${profileId}/rules/${rule.id}`, {
        method: 'PUT',
        token,
        body: JSON.stringify(ruleBody(rule, { enabled }))
      });
      await onChanged(enabled ? '规则已启用。' : '规则已停用。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新失败');
    } finally {
      finishMutation();
    }
  }

  async function move(rule: StashRule, offset: number) {
    if (rule.type === 'MATCH') return;
    const ids = snapshot.rules.map((item) => item.id);
    const index = ids.indexOf(rule.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target > lastMovableIndex || !beginMutation(rule.id)) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await apiRequest(`/api/profiles/${profileId}/rules/order`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ ids })
      });
      await onChanged('规则优先级已更新。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '排序失败');
    } finally {
      finishMutation();
    }
  }

  async function remove(rule: StashRule) {
    if ((rule.type === 'MATCH' && matchCount <= 1) || mutationLock.current) return;
    if (!window.confirm(`删除优先级 ${rule.priority} 的 ${rule.type} 规则？`))
      return;
    if (!beginMutation(rule.id)) return;
    try {
      await apiRequest(`/api/profiles/${profileId}/rules/${rule.id}`, {
        method: 'DELETE',
        token
      });
      await onChanged('规则已删除，后续优先级已自动前移。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除失败');
    } finally {
      finishMutation();
    }
  }

  return (
    <section className="panel rules-panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">ROUTING / EVALUATION ORDER</p>
          <h2>路由规则</h2>
          <p>自上而下匹配；数字越小优先级越高，MATCH 存在时锁定在末位。</p>
        </div>
        <button className="button primary" onClick={onAdd} disabled={busy !== null}>
          <Plus size={16} />
          新增规则
        </button>
      </div>

      <RoutingSimulator
        key={snapshot.profile.revision}
        profileId={profileId}
        token={token}
      />
      <div className="list-toolbar">
        <label className="search-box">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索域名、策略、类型、备注"
          />
        </label>
        <span>
          {rules.length} / {snapshot.rules.length} 条
        </span>
      </div>

      <div className="rules-stack">
        {rules.map((rule) => {
          const locked = rule.type === 'MATCH';
          const index = snapshot.rules.findIndex((item) => item.id === rule.id);
          const issues = issuesByRule.get(rule.id) || [];
          const hasError = issues.some((issue) => issue.severity === 'error');
          return (
            <article
              className={`rule-card${rule.enabled ? '' : ' is-disabled'}${
                hasError ? ' has-error' : ''
              }`}
              key={rule.id}
            >
              <div className="priority-block">
                <strong>{String(rule.priority).padStart(2, '0')}</strong>
                <span>PRIORITY</span>
              </div>
              <div className="rule-body">
                <div className="rule-main">
                  <StatusBadge tone={locked ? 'warn' : 'muted'}>
                    {rule.type}
                  </StatusBadge>
                  <code>{locked ? 'fallback match' : rule.payload}</code>
                </div>
                <div className="rule-target">
                  <span>→</span>
                  <strong>{rule.policy}</strong>
                  {rule.options.map((option) => (
                    <code key={option}>{option}</code>
                  ))}
                </div>
                {rule.note ? <p>{rule.note}</p> : null}
                {issues.length ? (
                  <div className="rule-diagnostics">
                    <ShieldAlert size={14} />
                    <span>{issues[0].message}</span>
                  </div>
                ) : null}
              </div>
              <div className="rule-actions">
                <SwitchField
                  label={rule.enabled ? '启用' : '停用'}
                  checked={rule.enabled}
                  onCheckedChange={(checked) => toggle(rule, checked)}
                  description=""
                  disabled={(locked && rule.enabled) || busy !== null}
                />
                <div className="icon-strip">
                  <button
                    className="icon-button"
                    aria-label="查看关联"
                    title="查看关联"
                    onClick={() => onInspect(rule)}
                  >
                    <Network size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="上移"
                    disabled={locked || index <= 0 || busy !== null}
                    onClick={() => move(rule, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="下移"
                    disabled={
                      locked ||
                      index >= lastMovableIndex ||
                      busy !== null
                    }
                    onClick={() => move(rule, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="编辑"
                    disabled={busy !== null}
                    onClick={() => onEdit(rule)}
                  >
                    <Edit3 size={15} />
                  </button>
                  {locked && matchCount <= 1 ? (
                    <span className="lock-note">
                      <LockKeyhole size={14} />
                      LOCKED
                    </span>
                  ) : (
                    <button
                      className="icon-button danger"
                      aria-label="删除"
                      disabled={busy !== null}
                      onClick={() => remove(rule)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </section>
  );
}
