import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  GraphKind,
  ResourceGraph,
  ResourceNode
} from '../lib/resource-graph';
import {
  buildResourceTreeModel,
  continuesResourceTreePath,
  resourceTreePath
} from '../lib/resource-tree';

function node(key: string, kind: GraphKind): ResourceNode {
  return { key, kind, id: 1, name: key, label: key, description: '' };
}

test('tree roots and children preserve route and member order, including shared references', () => {
  const graph: ResourceGraph = {
    nodes: [
      node('r2', 'rules'),
      node('r1', 'rules'),
      node('group', 'proxy-groups'),
      node('b', 'proxies'),
      node('a', 'proxies')
    ],
    edges: [
      { from: 'r2', to: 'group', label: 'policy' },
      { from: 'r1', to: 'group', label: 'policy' },
      { from: 'group', to: 'b', label: 'member' },
      { from: 'group', to: 'a', label: 'member' }
    ]
  };
  const model = buildResourceTreeModel(graph);
  assert.deepEqual(
    model.sections[0].roots.map((n) => n.key),
    ['r2', 'r1']
  );
  assert.equal(model.children.get('r2')![0].to, 'group');
  assert.equal(model.children.get('r1')![0].to, 'group');
  assert.deepEqual(
    model.children.get('group')!.map((e) => e.to),
    ['b', 'a']
  );
  assert.equal(
    model.sections.some((s) => s.id === 'other'),
    false
  );
  assert.deepEqual(resourceTreePath(model, 'a'), ['r2', 'group', 'a']);
  const path = resourceTreePath(model, 'a');
  assert.equal(continuesResourceTreePath(path, ['r2'], 'group'), true);
  assert.equal(continuesResourceTreePath(path, ['r1'], 'group'), false);
  assert.equal(continuesResourceTreePath(path, ['r2', 'group'], 'a'), true);
  assert.equal(continuesResourceTreePath(path, ['r2', 'group'], 'b'), false);
});

test('tree indexing terminates with cycles and retains missing and disconnected resources', () => {
  const model = buildResourceTreeModel({
    nodes: [
      node('rule', 'rules'),
      node('a', 'proxy-groups'),
      node('b', 'proxy-groups'),
      node('missing', 'missing'),
      node('unused', 'proxies'),
      node('builtin', 'builtin')
    ],
    edges: [
      { from: 'rule', to: 'a', label: 'policy' },
      { from: 'a', to: 'b', label: 'member' },
      { from: 'b', to: 'a', label: 'member' },
      { from: 'b', to: 'missing', label: 'member' }
    ]
  });
  assert.deepEqual(
    model.sections.find((s) => s.id === 'other')!.roots.map((n) => n.key),
    ['unused']
  );
  assert.equal(model.children.get('b')![0].to, 'a');
  assert.equal(model.nodes.get('missing')!.kind, 'missing');
  assert.deepEqual(resourceTreePath(model, 'missing'), [
    'rule',
    'a',
    'b',
    'missing'
  ]);
  assert.deepEqual(resourceTreePath(model, 'unused'), ['unused']);
  assert.deepEqual(resourceTreePath(model, 'nonexistent'), []);
});

test('DNS and extension references are separate entry points without treating their resources as unused', () => {
  const model = buildResourceTreeModel({
    nodes: [
      node('dns', 'settings'),
      node('set', 'rule-providers'),
      node('script', 'advanced')
    ],
    edges: [{ from: 'dns', to: 'set', label: 'DNS reference' }]
  });
  assert.deepEqual(
    model.sections.map((s) => s.id),
    ['extensions']
  );
  assert.deepEqual(
    model.sections[0].roots.map((n) => n.key),
    ['dns', 'script']
  );
});
