'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  Activity,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  Globe2,
  Layers3,
  Link2,
  ShieldAlert
} from 'lucide-react';
import {
  buildResourceGraph,
  type GraphKind,
  type ResourceNode
} from '@/lib/resource-graph';
import {
  buildResourceTreeModel,
  continuesResourceTreePath,
  resourceTreePath,
  type ResourceTreeModel,
  type ResourceTreeSection
} from '@/lib/resource-tree';
import type { Snapshot } from '@/lib/types';

const PAGE_SIZE = 16;
const icons: Partial<Record<GraphKind, typeof Box>> = {
  rules: Activity,
  'proxy-groups': Layers3,
  'proxy-providers': Database,
  'rule-providers': Boxes,
  proxies: Box,
  settings: Globe2,
  advanced: FileCode2,
  missing: ShieldAlert,
  builtin: Globe2
};
interface TreeProps {
  model: ResourceTreeModel;
  selected?: string | null;
  reveal: readonly string[];
  onSelect: (node: ResourceNode) => void;
}
interface TreeEntry {
  node: ResourceNode;
  relation?: string;
}

function TreeList({
  entries,
  ancestors,
  openRoots = false,
  ...props
}: TreeProps & {
  entries: TreeEntry[];
  ancestors: string[];
  openRoots?: boolean;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const revealIndex = entries.reduce(
    (last, entry, index) =>
      continuesResourceTreePath(props.reveal, ancestors, entry.node.key)
        ? index
        : last,
    -1
  );
  const visibleLimit = Math.max(limit, revealIndex + 1);
  return (
    <ul className="resource-tree-list">
      {entries.slice(0, visibleLimit).map(({ node, relation }, index) => (
        <TreeBranch
          {...props}
          node={node}
          relation={relation}
          ancestors={ancestors}
          initialOpen={
            openRoots ||
            continuesResourceTreePath(props.reveal, ancestors, node.key)
          }
          key={`${node.key}:${relation || index}`}
        />
      ))}
      {entries.length > visibleLimit ? (
        <li className="resource-tree-more">
          <button
            className="text-action"
            onClick={() => setLimit(visibleLimit + PAGE_SIZE)}
          >
            再显示 {Math.min(PAGE_SIZE, entries.length - visibleLimit)} 项（剩余{' '}
            {entries.length - visibleLimit} 项）
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function TreeBranch({
  node,
  relation,
  ancestors,
  initialOpen,
  model,
  selected,
  reveal,
  onSelect
}: TreeProps & {
  node: ResourceNode;
  relation?: string;
  ancestors: string[];
  initialOpen: boolean;
}) {
  const [expanded, setExpanded] = useState(initialOpen);
  useEffect(() => {
    if (initialOpen) setExpanded(true);
  }, [initialOpen, reveal]);
  const groupId = useId();
  const cycle = ancestors.includes(node.key);
  const depthLimited = ancestors.length >= 20;
  const outgoing = model.children.get(node.key) || [];
  const canExpand = outgoing.length > 0 && !cycle && !depthLimited;
  const Icon = icons[node.kind] || Box;
  return (
    <li
      className={`resource-tree-branch ${node.kind === 'missing' ? 'is-missing' : ''}`}
    >
      <div
        className={`resource-tree-row ${selected === node.key ? 'is-selected' : ''}`}
      >
        {canExpand ? (
          <button
            className="resource-tree-toggle"
            aria-label={`${expanded ? '折叠' : '展开'} ${node.label}`}
            aria-expanded={expanded}
            aria-controls={expanded ? groupId : undefined}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <span className="resource-tree-leaf" aria-hidden="true" />
        )}
        <button
          className="resource-tree-resource"
          onClick={() => onSelect(node)}
          aria-label={`查看 ${node.label} 的关联`}
          aria-pressed={selected === node.key}
        >
          <Icon size={16} aria-hidden="true" />
          <span>
            <strong>{node.label}</strong>
            <small>{node.description}</small>
          </span>
        </button>
        {relation ? (
          <span className="resource-tree-relation">{relation}</span>
        ) : null}
        {cycle ? (
          <span className="resource-tree-warning">
            <Link2 size={12} />
            循环引用
          </span>
        ) : null}
        {depthLimited && outgoing.length && !cycle ? (
          <span className="resource-tree-warning">层级较深，点击查看关联</span>
        ) : null}
        {canExpand ? (
          <span className="resource-tree-count">{outgoing.length}</span>
        ) : null}
      </div>
      {canExpand && expanded ? (
        <div id={groupId}>
          <TreeList
            model={model}
            selected={selected}
            reveal={reveal}
            onSelect={onSelect}
            ancestors={[...ancestors, node.key]}
            entries={outgoing.map((edge) => ({
              node: model.nodes.get(edge.to)!,
              relation: edge.label
            }))}
          />
        </div>
      ) : null}
    </li>
  );
}

function TreeSection({
  section,
  ...props
}: TreeProps & { section: ResourceTreeSection }) {
  const [expanded, setExpanded] = useState(section.id === 'routes');
  useEffect(() => {
    if (section.roots.some((node) => props.reveal[0] === node.key))
      setExpanded(true);
  }, [props.reveal, section]);
  const groupId = useId();
  return (
    <section className="resource-tree-section">
      <h3>
        <button
          aria-expanded={expanded}
          aria-controls={expanded ? groupId : undefined}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {section.label}
          <span>{section.roots.length}</span>
        </button>
      </h3>
      {expanded ? (
        <div id={groupId}>
          <p className="resource-tree-description">{section.description}</p>
          <TreeList
            {...props}
            ancestors={[]}
            openRoots={section.id === 'routes'}
            entries={section.roots.map((node) => ({ node }))}
          />
        </div>
      ) : null}
    </section>
  );
}

export function ResourceTree({
  snapshot,
  selected,
  onSelect,
  query = '',
  compact = false
}: {
  snapshot: Snapshot;
  selected?: string | null;
  onSelect: (node: ResourceNode) => void;
  query?: string;
  compact?: boolean;
}) {
  const model = useMemo(
    () => buildResourceTreeModel(buildResourceGraph(snapshot)),
    [snapshot]
  );
  const reveal = useMemo(
    () => (selected ? resourceTreePath(model, selected) : []),
    [model, selected]
  );
  const search = query.trim().toLocaleLowerCase();
  const matches = search
    ? [...model.nodes.values()].filter((node) =>
        `${node.name} ${node.label} ${node.description}`
          .toLocaleLowerCase()
          .includes(search)
      )
    : [];
  return (
    <div
      className={`resource-tree ${compact ? 'is-compact' : ''}`}
      role="region"
      aria-label="配置关系树"
      key={snapshot.profile.id}
    >
      {search ? (
        <div key={search}>
          <p className="resource-tree-description">
            找到 {matches.length} 个资源，展开查看它们引用的对象。
          </p>
          {matches.length ? (
            <TreeList
              model={model}
              selected={selected}
              reveal={reveal}
              onSelect={onSelect}
              entries={matches.map((node) => ({ node }))}
              ancestors={[]}
            />
          ) : (
            <p className="empty-state compact">没有匹配的资源。</p>
          )}
        </div>
      ) : (
        model.sections.map((section) => (
          <TreeSection
            key={section.id}
            section={section}
            model={model}
            selected={selected}
            reveal={reveal}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}
