'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

import { BUILTIN_POLICIES, type Snapshot, type StashRule, type ValidationResult } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';
import { Modal, SelectField, StatusBadge, SwitchField } from './ui';
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
  const [selected, setSelected] = useState<number[]>([]);
  const [batchPolicy, setBatchPolicy] = useState('');
  const [pendingRemove, setPendingRemove] = useState<StashRule | null>(null);
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

  useEffect(() => {
    const available = new Set(snapshot.rules.filter((rule) => rule.type !== 'MATCH').map((rule) => rule.id));
    setSelected((current) => current.filter((id) => available.has(id)));
  }, [snapshot.rules]);
  const selectedIds = snapshot.rules.filter((rule) => selected.includes(rule.id) && rule.type !== 'MATCH').map((rule) => rule.id);
  const visibleIds = rules.filter((rule) => rule.type !== 'MATCH').map((rule) => rule.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const policyOptions = Array.from(new Set([...BUILTIN_POLICIES, ...snapshot.proxies.map((item) => item.name), ...snapshot.proxyGroups.map((item) => item.name)]));

  async function batch(action: { policy?: string; enabled?: boolean; move?: 'top' | 'bottom' | 'up' | 'down' }) {
    if (!selectedIds.length || !beginMutation(-1)) return;
    try {
      await apiRequest(`/api/profiles/${profileId}/rules/batch`, { method: 'PUT', token, expectedRevision: snapshot.profile.revision, body: JSON.stringify({ ids: selectedIds, ...action }) });
      await onChanged(`已一次性更新 ${selectedIds.length} 条规则。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '批量更新失败');
    } finally { finishMutation(); }
  }

  async function toggle(rule: StashRule, enabled: boolean) {
    if (rule.type === 'MATCH' && (!enabled || rule.enabled)) return;
    if (!beginMutation(rule.id)) return;
    try {
      await apiRequest(`/api/profiles/${profileId}/rules/${rule.id}`, {
        method: 'PUT',
        token,
        expectedRevision: snapshot.profile.revision,
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
        expectedRevision: snapshot.profile.revision,
        body: JSON.stringify({ ids })
      });
      await onChanged('规则优先级已更新。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '排序失败');
    } finally {
      finishMutation();
    }
  }

  function requestRemove(rule: StashRule) {
    if ((rule.type === 'MATCH' && matchCount <= 1) || mutationLock.current) return;
    setPendingRemove(rule);
  }

  async function confirmRemove() {
    const rule = pendingRemove;
    if (!rule || mutationLock.current) return;
    if (!beginMutation(rule.id)) return;
    try {
      await apiRequest(`/api/profiles/${profileId}/rules/${rule.id}`, {
        method: 'DELETE',
        token,
        expectedRevision: snapshot.profile.revision
      });
      setPendingRemove(null);
      await onChanged('规则已删除，后续优先级已自动前移。');
    } catch (caught) {
      setPendingRemove(null);
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

      <div className="batch-toolbar" aria-label="批量规则操作">
        <label className="batch-select"><input type="checkbox" aria-label="选择筛选后的全部普通规则" checked={allVisibleSelected} disabled={busy !== null || !visibleIds.length} onChange={(event) => setSelected((current) => event.target.checked ? Array.from(new Set([...current, ...visibleIds])) : current.filter((id) => !visibleIds.includes(id)))} />选择当前筛选结果</label>
        <span>已选 {selectedIds.length} 条（MATCH 受保护）</span>
        {selectedIds.length ? <button className="text-action" disabled={busy !== null} onClick={() => setSelected([])}>清空选择</button> : null}
        {selectedIds.length ? <div className="batch-actions">
          <SelectField label="批量目标策略" value={batchPolicy} options={policyOptions.map((policy) => ({ value: policy, label: policy }))} onValueChange={setBatchPolicy} disabled={busy !== null} />
          <button className="button secondary small" disabled={busy !== null || !batchPolicy} onClick={() => void batch({ policy: batchPolicy })}>批量改策略</button>
          <button className="button secondary small" disabled={busy !== null} onClick={() => void batch({ enabled: true })}>批量启用</button>
          <button className="button secondary small" disabled={busy !== null} onClick={() => void batch({ enabled: false })}>批量停用</button>
          <button className="button secondary small" disabled={busy !== null} onClick={() => void batch({ move: 'up' })}>整体上移</button>
          <button className="button secondary small" disabled={busy !== null} onClick={() => void batch({ move: 'down' })}>整体下移</button>
          <button className="button secondary small" disabled={busy !== null} onClick={() => void batch({ move: 'top' })}>移到最前</button>
          <button className="button secondary small" disabled={busy !== null} onClick={() => void batch({ move: 'bottom' })}>移到兜底前</button>
        </div> : null}
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
                {!locked ? <label className="rule-select-target"><input type="checkbox" aria-label={`选择规则 ${rule.priority}`} checked={selected.includes(rule.id)} disabled={busy !== null} onChange={(event) => setSelected((current) => event.target.checked ? [...current, rule.id] : current.filter((id) => id !== rule.id))} /></label> : null}
                <strong>{String(rule.priority).padStart(2, '0')}</strong>
                <span>顺序</span>
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
                      onClick={() => requestRemove(rule)}
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
      <Modal
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setPendingRemove(null);
        }}
        title={
          pendingRemove
            ? `删除优先级 ${pendingRemove.priority} 的 ${pendingRemove.type} 规则？`
            : '确认删除'
        }
        description="删除会生成一个新的配置修订，后续规则优先级会自动前移。"
        footer={
          <>
            <button
              className="button secondary"
              onClick={() => setPendingRemove(null)}
              disabled={busy !== null}
            >
              取消
            </button>
            <button
              className="button danger"
              onClick={confirmRemove}
              disabled={busy !== null}
            >
              {busy !== null ? '删除中…' : '删除'}
            </button>
          </>
        }
      >
        <p className="delivery-note">
          删除后只能从版本历史恢复。MATCH 规则仍受末位保护。
        </p>
      </Modal>
    </section>
  );
}
