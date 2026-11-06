'use client';

import { useMemo, useState } from 'react';
import {
  Boxes,
  Box,
  Database,
  Edit3,
  Globe2,
  Layers3,
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

const RULESET_CATEGORY_LABELS: Record<string, string> = {
  'media-streaming': '流媒体',
  general: '通用服务',
  googleai: 'Google AI',
  'media-youtube': 'YouTube',
  developer: '开发者服务',
  ai: 'AI 服务',
  social: '社交平台',
  safety: '安全防护',
  ads: '广告拦截',
  google: 'Google 服务',
  telegram: 'Telegram',
  twitter: 'X / Twitter'
};

function humanizeRuleSetName(item: RuleProvider): string {
  const entryValues = item.entries.map((entry) => entry.value.toLowerCase());
  const containsAny = (...needles: string[]) =>
    needles.some((needle) => entryValues.some((value) => value.includes(needle)));

  if (containsAny('apple-relay', 'guzzoni.apple.com', 'smoot.apple.com', 'api-siri')) {
    return 'Apple Intelligence · Siri 与 Relay';
  }
  if (containsAny('push.apple.com')) return 'Apple 推送服务';
  if (containsAny('servicewechat.com', 'weixin.qq.com', 'wechat.com')) {
    return '微信服务';
  }
  if (containsAny('home.arpa', '.lan', '.local')) return '家庭与局域网域名';
  if (item.behavior === 'ipcidr' && entryValues.some((value) => /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|fc|fe80)/.test(value))) {
    return '局域网与保留 IP 网段';
  }
  if (item.behavior === 'ipcidr' && entryValues.some((value) => value.startsWith('17.'))) {
    return 'Apple 服务 IP 网段';
  }

  const numbered = item.name.match(/^hj-\d+-(.+)-(domain|ipcidr)-(\d+)$/i);
  if (numbered) {
    const [, category, ruleType, index] = numbered;
    const categoryLabel = RULESET_CATEGORY_LABELS[category] ||
      category.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
    const typeLabel = ruleType.toLowerCase() === 'ipcidr' ? 'IP 网段规则' : '域名规则';
    return `${categoryLabel} · ${typeLabel} ${index.padStart(2, '0')}`;
  }

  const remoteName = item.name.match(/^Repcz-(.+)$/i);
  if (remoteName) {
    const slug = remoteName[1];
    const ads = slug.match(/^Ads-(.+)$/i);
    if (ads) return `广告拦截 · ${ads[1]}`;
    return RULESET_CATEGORY_LABELS[slug.toLowerCase()] || slug;
  }

  return item.name;
}

function itemName(item: ResourceItem, kind: ResourceKind): string {
  if (kind === 'rule-providers') return humanizeRuleSetName(item as RuleProvider);
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
    const behavior = {
      domain: '域名',
      ipcidr: 'IP 网段',
      classical: '混合规则'
    }[provider.behavior] || provider.behavior;
    return `${source} · ${behavior}`;
  }
  if (kind === 'proxy-providers') {
    return (item as ProxyProvider).requiresUrl ? 'request-scoped url' : 'stored source';
  }
  return 'host map';
}

function itemSummary(item: ResourceItem, kind: ResourceKind): string[] {
  if (kind === 'proxies') {
    const proxy = item as ProxyNode;
    return Object.entries(proxy.config)
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
  onEdit,
  onDelete
}: {
  kind: ResourceKind;
  title: string;
  subtitle: string;
  items: ResourceItem[];
  onAdd: () => void;
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
          <p className="kicker">{kind.toUpperCase()} / SQLITE</p>
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
        <span>{visible.length} / {items.length}</span>
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
                {kind === 'rule-providers' ? (
                  <code className="resource-identifier" title="规则集配置标识">
                    {rawItemName(item)}
                  </code>
                ) : null}
              </div>
              <div className="card-actions">
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
