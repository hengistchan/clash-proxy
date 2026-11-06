'use client';

import {
  Activity,
  ArrowRight,
  Box,
  Boxes,
  Database,
  Globe2,
  Layers3,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';

import type { Snapshot, ValidationResult } from '@/lib/types';

import { StatusBadge } from './ui';
import { ExportView } from './export-view';

export function OverviewView({
  snapshot,
  token,
  validation,
  onNavigate
}: {
  snapshot: Snapshot;
  token: string;
  validation: ValidationResult;
  onNavigate: (section: string) => void;
}) {
  const errors = validation.issues.filter((item) => item.severity === 'error');
  const warnings = validation.issues.filter(
    (item) => item.severity === 'warning'
  );
  const stats = [
    {
      label: '代理源',
      value: snapshot.proxyProviders.length,
      icon: Database,
      section: 'proxy-providers'
    },
    {
      label: '直接节点',
      value: snapshot.proxies.length,
      icon: Box,
      section: 'proxies'
    },
    {
      label: '策略组',
      value: snapshot.proxyGroups.length,
      icon: Layers3,
      section: 'proxy-groups'
    },
    {
      label: '规则集',
      value: snapshot.ruleProviders.length,
      icon: Boxes,
      section: 'rule-providers'
    },
    {
      label: '路由规则',
      value: snapshot.rules.length,
      icon: Activity,
      section: 'rules'
    },
    {
      label: 'Hosts',
      value: snapshot.hosts.length,
      icon: Globe2,
      section: 'hosts'
    }
  ];

  return (
    <div className="overview-stack">
      <section className="overview-hero">
        <div>
          <p className="kicker">当前配置</p>
          <h2>{snapshot.profile.name}</h2>
          <p>
            Revision {snapshot.profile.revision} · {snapshot.profile.mode} mode
            · {snapshot.profile.logLevel} logging
          </p>
        </div>
        <StatusBadge tone={errors.length ? 'bad' : 'good'}>
          {errors.length ? `${errors.length} 个待处理问题` : '结构检查通过'}
        </StatusBadge>
      </section>

      <ExportView
        snapshot={snapshot}
        validation={validation}
        profileId={snapshot.profile.id}
        token={token}
        compact
      />
      <div className="stat-grid">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <button
              className="stat-card"
              key={stat.label}
              onClick={() => onNavigate(stat.section)}
            >
              <Icon size={18} />
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
              <ArrowRight size={14} className="stat-arrow" />
            </button>
          );
        })}
      </div>

      <section className="dependency-map">
        <div className="dependency-copy">
          <p className="kicker">ROUTING PIPELINE</p>
          <h2>查看资源之间的实际关联</h2>
          <button
            className="button secondary small"
            onClick={() => onNavigate('relationships')}
          >
            打开关联关系
          </button>
          <p>
            远程代理源先由策略组筛选；规则层只引用策略组或直接节点； 规则集和
            DNS 共享命名空间。删除与重命名会检查引用关系。
          </p>
        </div>
        <div className="pipeline">
          <div>
            <Database size={17} />
            <strong>{snapshot.proxyProviders.length}</strong>
            <span>Proxy Providers</span>
          </div>
          <ArrowRight size={18} />
          <div>
            <Layers3 size={17} />
            <strong>{snapshot.proxyGroups.length}</strong>
            <span>Strategy Groups</span>
          </div>
          <ArrowRight size={18} />
          <div>
            <Boxes size={17} />
            <strong>{snapshot.ruleProviders.length}</strong>
            <span>Rule Providers</span>
          </div>
          <ArrowRight size={18} />
          <div>
            <Activity size={17} />
            <strong>{snapshot.rules.length}</strong>
            <span>Ordered Rules</span>
          </div>
        </div>
      </section>

      <section className="validation-panel">
        <div className="validation-head">
          {errors.length ? (
            <ShieldAlert size={22} />
          ) : (
            <ShieldCheck size={22} />
          )}
          <div>
            <h3>配置检查</h3>
            <p>
              {validation.issues.length
                ? `${errors.length} 个错误，${warnings.length} 个警告`
                : '未发现结构性问题'}
            </p>
          </div>
          <button
            className="button secondary small"
            onClick={() => onNavigate('export')}
          >
            下载配置
          </button>
        </div>
        <div className="issues-list">
          {validation.issues.slice(0, 8).map((issue, index) => (
            <article
              className={`issue-row severity-${issue.severity}`}
              key={`${issue.code}-${index}`}
            >
              <StatusBadge
                tone={
                  issue.severity === 'error'
                    ? 'bad'
                    : issue.severity === 'warning'
                      ? 'warn'
                      : 'muted'
                }
              >
                {
                  { error: '错误', warning: '警告', info: '提示' }[
                    issue.severity
                  ]
                }
              </StatusBadge>
              <span>{issue.message}</span>
              <code>{issue.code}</code>
              {issue.resource ? (
                <button
                  className="button secondary small"
                  onClick={() =>
                    onNavigate(
                      (
                        {
                          'proxy-provider': 'proxy-providers',
                          'proxy-group': 'proxy-groups',
                          'rule-provider': 'rule-providers',
                          rule: 'rules',
                          proxy: 'proxies'
                        } as Record<string, string>
                      )[issue.resource!] || 'settings'
                    )
                  }
                >
                  处理
                </button>
              ) : null}
            </article>
          ))}
          {validation.issues.length === 0 ? (
            <div className="empty-state compact">
              <strong>结构、引用和 MATCH 终位检查均通过。</strong>
              <span>
                远程订阅是否可下载属于运行时检查，不在离线校验中伪装为通过。
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
