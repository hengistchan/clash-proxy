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

import type { Snapshot, ValidationResult, ValidationIssue } from '@/lib/types';

import { StatusBadge } from './ui';
import { DeliverySummary } from './delivery-summary';
import type { DeliveryWorkspace } from './use-delivery-workspace';
import type { ConfigTarget } from '@/lib/config-targets';
import { ValidationIssues } from './validation-issues';
import { ResourceTree } from './resource-tree';
import type { ResourceNode } from '@/lib/resource-graph';

export function OverviewView({
  snapshot,
  delivery,
  onDelivery,
  validation,
  onNavigate,
  onInspect,
  onFixIssue,
  onImport
}: {
  snapshot: Snapshot;
  delivery: DeliveryWorkspace;
  onDelivery: (target: ConfigTarget) => void;
  validation: ValidationResult;
  onNavigate: (section: string) => void;
  onInspect: (node: ResourceNode) => void;
  onFixIssue: (issue: ValidationIssue) => void;
  onImport: () => void;
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

      <section className="workflow-guide" aria-label="配置与交付流程">
        <article>
          <span className="workflow-number">1</span><div><h3>准备配置资源</h3><p>导入 Stash YAML 或 Shadowrocket .conf，或按需添加来源、策略和路由。</p>
          <div className="delivery-actions"><button className="button secondary small" onClick={onImport}>导入已有配置</button><button className="text-action" onClick={() => onNavigate('relationships')}>管理资源关系</button></div></div>
        </article>
        <article>
          <span className="workflow-number">2</span><div><h3>{errors.length ? `修复 ${errors.length} 个问题` : '检查配置'}</h3><p>{errors.length ? '草稿已保留；定位具体资源，修复后自动生成新版本。' : '结构检查已通过。各客户端能否交付，请看下方状态。'}</p>
          <button className="text-action" onClick={() => errors.length ? onFixIssue(errors[0]) : onNavigate('rules')}>{errors.length ? '处理首个错误' : '模拟路由匹配'}</button></div>
        </article>
        <article>
          <span className="workflow-number">3</span><div><h3>交付到设备</h3><p>下载成功版本，或生成随配置更新的固定订阅链接。</p><button className="text-action" onClick={() => onNavigate('export')}>打开下载与设备订阅</button></div>
        </article>
      </section>

      <DeliverySummary delivery={delivery} revision={snapshot.profile.revision} onOpen={onDelivery} />
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
        <ValidationIssues issues={validation.issues} onFix={onFixIssue} />
      </section>
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
        <div className="dependency-tree-heading">
          <div className="dependency-copy">
            <p className="kicker">配置关系树</p>
            <h2>从规则一路看到流量出口</h2>
            <p>
              展开分支查看策略、成员与来源；点击资源查看使用者并继续编辑。树展示当前配置的引用，实际匹配取决于运行模式。
            </p>
          </div>
          <button
            className="button secondary small"
            onClick={() => onNavigate('relationships')}
          >
            打开关联关系
          </button>
        </div>
        <ResourceTree snapshot={snapshot} compact onSelect={onInspect} />
      </section>


    </div>
  );
}
