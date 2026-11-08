import { parseYamlDocument } from './yaml-import';
import { isShadowrocketDocument, parseShadowrocketDocument } from './shadowrocket-import';
import { storeResource, type StoredResourceKind } from './config-storage-model';
import { isJsonObject, type JsonValue } from './types';

export function parseConfigDocument(text: string) {
  return isShadowrocketDocument(text) ? parseShadowrocketDocument(text) : parseYamlDocument(text);
}

export function classifyConfig(text: string, doc = parseConfigDocument(text)) {
  const shadowrocket = isShadowrocketDocument(text);
  const common = new Set<string>();
  const stash = new Set<string>();
  const native = new Set<string>();
  const publicStashFields = new Set([
    'lazy', 'ssid-policy', 'include-all', 'use-url', 'fake-ip-range', 'fake-ip-filter',
    'nameserver-policy', 'script', 'http', 'cron', 'script-providers', 'plugin', 'plugin-opts'
  ]);
  const addStash = (label: string, keys: string[]) => {
    const known = keys.filter((key) => publicStashFields.has(key));
    stash.add(known.length ? `${label}（${known.join('、')}）` : label);
  };
  function record(kind: StoredResourceKind, value: JsonValue, label: string) {
    const stored = storeResource(kind, value);
    if (!isJsonObject(stored)) return;
    if (isJsonObject(stored.common) && Object.keys(stored.common).length) common.add(label);
    if (isJsonObject(stored.extensions) && isJsonObject(stored.extensions.stash) && Object.keys(stored.extensions.stash).length) {
      addStash(label, Object.keys(stored.extensions.stash));
    }
  }
  if (doc.proxies.length) common.add('节点与协议');
  if (doc.rules.length) common.add('分流规则及顺序');
  if (doc.hosts.length) common.add('Hosts 映射');
  if (doc.ruleProviders.length) common.add('规则集及来源');
  if (doc.proxyGroups.length) common.add('策略组类型及成员');
  if (isJsonObject(doc.settings.dns)) {
    if ('nameserver' in doc.settings.dns || 'proxy-server-nameserver' in doc.settings.dns) common.add('DNS 服务器');
    const extra = Object.keys(doc.settings.dns).filter((key) => !['nameserver', 'proxy-server-nameserver'].includes(key));
    if (extra.length) addStash('DNS 专用设置', extra);
  }
  doc.proxies.forEach((node) => record('node', node.config, '节点参数'));
  doc.proxyProviders.forEach((source) => record('nodeSource', source.config, '代理源参数'));
  doc.proxyGroups.forEach((group) => {
    record('policyGroup', group.config, '策略组参数');
    if (group.clientOptions?.shadowrocket) native.add(`策略组选项（${Object.keys(group.clientOptions.shadowrocket).join('、')}）`);
  });
  doc.ruleProviders.forEach((source) => {
    record('ruleSource', source.config, '规则集参数');
    if (source.clientOptions?.shadowrocket) native.add('原生 RULE-SET / DOMAIN-SET 引用');
  });
  if (doc.advancedSections.length) addStash('高级区块', doc.advancedSections.map((item) => item.key));
  const options = doc.clientOptions?.shadowrocket;
  if (Array.isArray(options?.general) && options.general.length) native.add('全局专用设置');
  if (Array.isArray(options?.sections) && options.sections.length) {
    const names = options.sections.flatMap((section) => isJsonObject(section) && typeof section.name === 'string' ? [section.name] : []);
    native.add(`专用区块（${names.join('、')}）`);
  }
  return { format: shadowrocket ? 'shadowrocket' : 'stash', common: [...common], stash: [...stash], shadowrocket: [...native] } as const;
}
