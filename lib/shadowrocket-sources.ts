import { readRemoteNodes, readRemoteYamlMapping } from './remote-proxy-nodes';
import { type JsonObject, type ProxyNode, type ValidationIssue } from './types';
import { downloadSource, PrivateSourceAddressError, type SourceDownload } from './upstream-download';

export type RemoteSource =
  | { kind: 'proxy-provider'; id: number; config: JsonObject }
  | { kind: 'rule-provider'; id: number; config: JsonObject };

export interface RemoteResources {
  nodes: Map<number, ProxyNode[]>;
  rules: Map<number, string[]>;
}

const MAX_SOURCES = 24;
const MAX_ENTRIES = 50_000;
const MAX_LINE_LENGTH = 2_048;

export function readRemoteRules(text: string, format: 'yaml' | 'text') {
  const entries = format === 'yaml' ? readRemoteYamlMapping(text).payload : text.split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES ||
    !entries.every((value) => typeof value === 'string' && value.trim() && value.length <= MAX_LINE_LENGTH)) {
    throw new Error('Invalid rule list');
  }
  return (entries as string[]).map((line) => line.trim());
}

export async function readRemoteSources(sources: RemoteSource[], fetchSource: SourceDownload = downloadSource) {
  const resources: RemoteResources = { nodes: new Map(), rules: new Map() };
  const issues: ValidationIssue[] = [];
  if (sources.length > MAX_SOURCES) {
    issues.push({ severity: 'error', code: 'shadowrocket.source.limit', message: '同一份配置最多展开 24 个远程来源。' });
    return { resources, issues };
  }
  const timeout = AbortSignal.timeout(12_000);
  for (let i = 0; i < sources.length; i += 4) {
    const results = await Promise.all(sources.slice(i, i + 4).map(async (source): Promise<ValidationIssue | undefined> => {
      let text: string;
      try {
        timeout.throwIfAborted();
        text = await fetchSource(source.config, timeout);
      } catch (error) {
        if (error instanceof PrivateSourceAddressError) {
          return { severity: 'error', code: 'shadowrocket.source.address', message: '远程来源解析到非公网地址，已阻止下载。若本机使用 Fake IP，请检查服务端 DNS 设置。', resource: source.kind, resourceId: source.id };
        }
        return { severity: 'error', code: 'shadowrocket.source.fetch', message: '远程来源下载失败。请检查地址、认证、网络或响应大小。', resource: source.kind, resourceId: source.id };
      }
      try {
        if (source.kind === 'proxy-provider') resources.nodes.set(source.id, readRemoteNodes(text, source.id));
        else resources.rules.set(source.id, readRemoteRules(text, source.config.format === 'text' ? 'text' : 'yaml'));
      } catch {
        return { severity: 'error', code: 'shadowrocket.source.format', message: '远程内容与声明的格式不符、为空或超出大小限制。', resource: source.kind, resourceId: source.id };
      }
    }));
    for (const result of results) if (result) issues.push(result);
  }
  return { resources, issues };
}
