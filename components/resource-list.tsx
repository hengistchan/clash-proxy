'use client';

import { useMemo, useState } from 'react';
import {
  Boxes,
  Box,
  Database,
  Edit3,
  Globe2,
  Layers3,
  Network,
  Plus,
  Search,
  Trash2
} from 'lucide-react';

import type {
  HostEntry,
  ProxyGroup,
  ProxyNode,
  ProxyProvider,
  ResourceKind,
  RuleProvider,
  Snapshot
} from '@/lib/types';

import { StatusBadge } from './ui';

type ResourceItem =
  | ProxyNode
  | ProxyProvider
  | ProxyGroup
  | RuleProvider
  | HostEntry;

function rawItemName(item: ResourceItem): string {
  if ('name' in item) return item.name;
  return item.pattern;
}

function itemName(item: ResourceItem, kind: ResourceKind): string {
  if (kind === 'rule-providers') {
    const provider = item as RuleProvider;
    return provider.displayName.trim() || provider.name;
  }
  return rawItemName(item);
}

function itemType(item: ResourceItem, kind: ResourceKind): string {
  if (kind === 'proxies') return (item as ProxyNode).type;
  if (kind === 'proxy-groups') return (item as ProxyGroup).type;
  if (kind === 'rule-providers') {
    const provider = item as RuleProvider;
    const source = {
      inline: '内嵌条目',
      remote: '远程下载',
      local: '本地文件'
    }[provider.providerType];
    const behavior =
      {
        domain: '域名',
        ipcidr: 'IP 网段',
        classical: '混合规则'
      }[provider.behavior] || provider.behavior;
    return `${source} · ${behavior}`;
  }
  if (kind === 'proxy-providers') {
    return (item as ProxyProvider).sourceConfigured
      ? '来源已配置'
      : '来源待填写';
  }
  return 'host map';
}

function itemSummary(item: ResourceItem, kind: ResourceKind): string[] {
  if (kind === 'proxies') {
    const proxy = item as ProxyNode;
    return Object.entries(proxy.config)
      .filter(
        ([key]) =>
          !/pass|secret|token|uuid|private.key|authorization/i.test(key)
      )
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${String(value)}`);
  }
  if (kind === 'proxy-providers') {
    const provider = item as ProxyProvider;
    return Object.entries(provider.config)
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${String(value)}`);
  }
  if (kind === 'proxy-groups') {
    const group = item as ProxyGroup;
    const members = Array.isArray(group.config.proxies)
      ? group.config.proxies.length
      : 0;
    const use = Array.isArray(group.config.use)
      ? group.config.use.map(String).join(', ')
      : '';
    return [
      `${members} 个显式成员`,
      Array.isArray(group.config.proxies) && group.config.proxies.length
        ? `成员: ${group.config.proxies.map(String).join(' → ')}`
        : '',
      use ? `use: ${use}` : '',
      typeof group.config.filter === 'string'
        ? `filter: ${group.config.filter}`
        : ''
    ].filter(Boolean);
  }
  if (kind === 'rule-providers') {
    const provider = item as RuleProvider;
    return [
      provider.providerType === 'inline'
        ? `${provider.entries.length} 个条目`
        : String(provider.config.url || provider.config.path || '未配置来源'),
      typeof provider.config.interval === 'number'
        ? `interval: ${provider.config.interval}s`
        : ''
    ].filter(Boolean);
  }
  return [`${(item as HostEntry).pattern} → ${(item as HostEntry).value}`];
}

function kindIcon(kind: ResourceKind) {
  if (kind === 'proxy-providers') return Database;
  if (kind === 'proxies') return Box;
  if (kind === 'proxy-groups') return Layers3;
  if (kind === 'rule-providers') return Boxes;
  return Globe2;
}

export function ResourceList({
  kind,
  title,
  subtitle,
  items,
  onAdd,
  onInspect,
  onEdit,
  onDelete
}: {
  kind: ResourceKind;
  title: string;
  subtitle: string;
  items: ResourceItem[];
  onAdd: () => void;
  onInspect: (item: ResourceItem) => void;
  onEdit: (item: ResourceItem) => void;
  onDelete: (item: ResourceItem) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const Icon = kindIcon(kind);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${itemName(item, kind)} ${rawItemName(item)} ${itemType(item, kind)} ${itemSummary(item, kind).join(' ')}`
        .toLowerCase()
        .includes(needle)
    );
  }, [items, kind, query]);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">资源管理</p>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button className="button primary" onClick={onAdd}>
          <Plus size={16} />
          新增
        </button>
      </div>

      <div className="list-toolbar">
        <label className="search-box">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、类型或配置摘要"
          />
        </label>
        <span>
          {visible.length} / {items.length}
        </span>
      </div>

      <div className="resource-grid">
        {visible.map((item) => (
          <article className="resource-card" key={item.id}>
            <header>
              <span className="resource-icon">
                <Icon size={17} />
              </span>
              <div className="resource-title">
                <strong>{itemName(item, kind)}</strong>
                <StatusBadge tone="muted">{itemType(item, kind)}</StatusBadge>
                {kind === 'rule-providers' &&
                (item as RuleProvider).displayName.trim() &&
                (item as RuleProvider).displayName !==
                  (item as RuleProvider).name ? (
                  <code className="resource-identifier" title="规则集配置标识">
                    {rawItemName(item)}
                  </code>
                ) : null}
              </div>
              <div className="card-actions">
                {kind !== 'hosts' ? (
                  <button
                    className="button secondary small"
                    aria-label={`查看 ${rawItemName(item)} 的关联`}
                    title="查看关联"
                    onClick={() => onInspect(item)}
                  >
                    <Network size={15} />
                    关联
                  </button>
                ) : null}
                <button
                  className="icon-button"
                  aria-label={`编辑 ${rawItemName(item)}`}
                  onClick={() => onEdit(item)}
                >
                  <Edit3 size={15} />
                </button>
                <button
                  className="icon-button danger"
                  aria-label={`删除 ${rawItemName(item)}`}
                  onClick={() => onDelete(item)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </header>
            <div className="resource-meta">
              {itemSummary(item, kind).map((line) => (
                <code key={line}>{line}</code>
              ))}
            </div>
          </article>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="empty-state">
          <strong>没有匹配项</strong>
          <span>调整搜索条件，或创建一个新资源。</span>
        </div>
      ) : null}
    </section>
  );
}
