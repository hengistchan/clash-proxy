'use client';
import { useMemo, useState } from 'react';
import { ArrowRight, Edit3, Network, Plus } from 'lucide-react';
import { buildResourceGraph, type ResourceNode } from '@/lib/resource-graph';
import type { Snapshot } from '@/lib/types';
import { ResourceTree } from './resource-tree';

export interface EditorPreset {
  policy?: string;
  payload?: string;
  type?: string;
  groupUse?: string[];
  groupProxies?: string[];
}
export function RelationshipsView({
  snapshot,
  focus,
  onFocus,
  onEdit,
  onCreate
}: {
  snapshot: Snapshot;
  focus: string | null;
  onFocus: (key: string) => void;
  onEdit: (node: ResourceNode) => void;
  onCreate: (kind: 'proxy-groups' | 'rules', preset: EditorPreset) => void;
}) {
  const [query, setQuery] = useState('');
  const graph = useMemo(() => buildResourceGraph(snapshot), [snapshot]);
  const selected =
    graph.nodes.find((n) => n.key === focus) ||
    graph.nodes.find((n) => n.kind === 'rules') ||
    graph.nodes[0];
  const relationList = (direction: 'incoming' | 'outgoing') => {
    const list = graph.edges.filter((e) =>
      direction === 'outgoing'
        ? e.from === selected?.key
        : e.to === selected?.key
    );
    return (
      <div className="relation-links">
        {list.length ? (
          list.map((edge, index) => {
            const node = graph.nodes.find(
              (n) => n.key === (direction === 'outgoing' ? edge.to : edge.from)
            )!;
            return (
              <button
                className={`relation-link ${node.kind === 'missing' ? 'is-missing' : ''}`}
                key={index}
                onClick={() => onFocus(node.key)}
              >
                <span>
                  <strong>{node.label}</strong>
                  <small>{node.description}</small>
                </span>
                <span className="relation-edge-label">
                  {edge.label}
                  <ArrowRight size={14} />
                </span>
              </button>
            );
          })
        ) : (
          <p className="delivery-note">
            {direction === 'outgoing'
              ? '没有直接引用其他资源。'
              : '当前配置没有资源引用它。'}
          </p>
        )}
      </div>
    );
  };
  if (!selected) return null;
  return (
    <section className="panel relationships-panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">配置关联</p>
          <h2>资源如何一起工作</h2>
          <p>
            展开树分支查看引用路径，点击资源查看“使用了谁”和“被谁使用”。同一资源可出现在多个分支；订阅内的节点尚未抓取。
          </p>
        </div>
        <Network size={24} />
      </div>
      <label className="field">
        <span>查找资源</span>
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按名称、标识或类型查找"
        />
      </label>
      <div className="relationship-workspace">
        <ResourceTree
          snapshot={snapshot}
          selected={selected.key}
          query={query}
          onSelect={(node) => onFocus(node.key)}
        />
        <div className="relation-inspector">
          <header>
            <div>
              <h3>{selected.label}</h3>
              <p className="delivery-note">{selected.description}</p>
            </div>
            {!['builtin', 'missing'].includes(selected.kind) ? (
              <button
                className="button secondary"
                onClick={() => onEdit(selected)}
              >
                <Edit3 size={15} />
                编辑这个资源
              </button>
            ) : null}
          </header>
          <div className="relation-directions">
            <section>
              <h4>它使用了谁</h4>
              {relationList('outgoing')}
            </section>
            <section>
              <h4>谁在使用它</h4>
              {relationList('incoming')}
            </section>
          </div>
          <div className="delivery-actions">
            {selected.kind === 'proxy-providers' ? (
              <button
                className="button primary"
                onClick={() =>
                  onCreate('proxy-groups', { groupUse: [selected.name] })
                }
              >
                <Plus size={15} />
                使用这个来源创建策略组
              </button>
            ) : null}
            {selected.kind === 'proxies' ? (
              <button
                className="button primary"
                onClick={() =>
                  onCreate('proxy-groups', { groupProxies: [selected.name] })
                }
              >
                <Plus size={15} />
                把这个节点放入新策略组
              </button>
            ) : null}
            {['proxy-groups', 'proxies', 'builtin'].includes(selected.kind) ? (
              <button
                className="button primary"
                onClick={() => onCreate('rules', { policy: selected.name })}
              >
                <Plus size={15} />
                添加指向此出口的规则
              </button>
            ) : null}
            {selected.kind === 'rule-providers' ? (
              <button
                className="button primary"
                onClick={() =>
                  onCreate('rules', {
                    type: 'RULE-SET',
                    payload: selected.name
                  })
                }
              >
                <Plus size={15} />
                添加使用此集合的规则
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
