import type {
  ResourceEdge,
  ResourceGraph,
  ResourceNode
} from './resource-graph';

export interface ResourceTreeSection {
  id: string;
  label: string;
  description: string;
  roots: ResourceNode[];
}

// Keep the graph indexed rather than expanding every possible path in a DAG.
// The view expands one branch at a time and stops at references to ancestors.
export function buildResourceTreeModel(graph: ResourceGraph) {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  const children = new Map<string, ResourceEdge[]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const list = children.get(edge.from) || [];
    list.push(edge);
    children.set(edge.from, list);
  }
  const routes = graph.nodes.filter((n) => n.kind === 'rules');
  const extensions = graph.nodes.filter((n) =>
    ['settings', 'advanced'].includes(n.kind)
  );
  const reached = new Set<string>();
  const pending = [...routes, ...extensions].map((n) => n.key);
  while (pending.length) {
    const key = pending.pop()!;
    if (reached.has(key)) continue;
    reached.add(key);
    for (const edge of children.get(key) || []) pending.push(edge.to);
  }
  const other = graph.nodes.filter(
    (node) => !reached.has(node.key) && node.kind !== 'builtin'
  );
  const sections: ResourceTreeSection[] = [
    {
      id: 'routes',
      label: '路由规则',
      description: '按页面与导出的规则顺序排列，展开查看匹配条件和流量出口。',
      roots: routes
    },
    {
      id: 'extensions',
      label: 'DNS 与扩展区块',
      description: '查看解析设置、脚本与其他区块中的明确引用。',
      roots: extensions
    },
    {
      id: 'other',
      label: '其他资源',
      description:
        '尚未从上述入口触达的资源；是否参与流量处理还取决于运行模式。',
      roots: other
    }
  ].filter((section) => section.roots.length > 0);
  return { nodes, children, sections };
}

export type ResourceTreeModel = ReturnType<typeof buildResourceTreeModel>;

export function continuesResourceTreePath(
  path: readonly string[],
  ancestors: readonly string[],
  key: string
) {
  return (
    path[ancestors.length] === key &&
    ancestors.every((ancestor, index) => ancestor === path[index])
  );
}

export function resourceTreePath(
  model: ResourceTreeModel,
  target: string
): string[] {
  const parents = new Map<string, string | null>();
  const queue: string[] = [];
  for (const section of model.sections) {
    for (const root of section.roots) {
      if (parents.has(root.key)) continue;
      parents.set(root.key, null);
      queue.push(root.key);
    }
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index];
      if (key === target) {
        const path = [key];
        let parent = parents.get(key);
        while (parent) {
          path.unshift(parent);
          parent = parents.get(parent);
        }
        return path;
      }
      for (const edge of model.children.get(key) || []) {
        if (parents.has(edge.to)) continue;
        parents.set(edge.to, key);
        queue.push(edge.to);
      }
    }
    queue.length = 0;
  }
  return [];
}
