'use client';

import { useState } from 'react';
import type { ValidationIssue } from '@/lib/types';
import { StatusBadge } from './ui';

const LABELS = { error: '错误', warning: '警告', info: '提示' } as const;

export function ValidationIssues({ issues, onFix }: {
  issues: ValidationIssue[];
  onFix?: (issue: ValidationIssue) => void;
}) {
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const filtered = issues.filter((issue) => filter === 'all' || issue.severity === filter);
  const visible = expanded ? filtered : filtered.slice(0, 8);
  return (
    <div>
      {issues.length ? <div className="diagnostic-filters" aria-label="检查结果筛选">
        {(['all', 'error', 'warning', 'info'] as const).map((severity) => (
          <button key={severity} className="button secondary small" aria-pressed={filter === severity}
            onClick={() => { setFilter(severity); setExpanded(false); }}>
            {severity === 'all' ? '全部' : LABELS[severity]} · {severity === 'all' ? issues.length : issues.filter((i) => i.severity === severity).length}
          </button>
        ))}
      </div> : null}
      <div className="issues-list" aria-live="polite">
        {visible.map((issue, index) => (
          <article className={`issue-row severity-${issue.severity}`} key={`${issue.code}-${issue.resourceId}-${index}`}>
            <StatusBadge tone={issue.severity === 'error' ? 'bad' : issue.severity === 'warning' ? 'warn' : 'muted'}>{LABELS[issue.severity]}</StatusBadge>
            <span>{issue.message}</span>
            <code>{issue.code}</code>
            {onFix && issue.resource ? <button className="button secondary small" onClick={() => onFix(issue)}>定位并处理</button> : null}
          </article>
        ))}
        {!filtered.length ? <div className="empty-state compact">
          <strong>{issues.length ? '此分类没有检查结果。' : '结构、引用和规则顺序检查通过。'}</strong>
          {!issues.length ? <span>节点连通性与实际分流效果需在设备中验证。</span> : null}
        </div> : null}
      </div>
      {filtered.length > 8 ? <button className="button secondary small" onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起检查结果' : `显示全部 ${filtered.length} 项检查结果`}
      </button> : null}
    </div>
  );
}
