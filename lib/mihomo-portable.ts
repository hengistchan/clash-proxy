import { parse, stringify } from 'yaml';
import { HttpError } from './http';
import { managedProxySource } from './managed-proxy-source';
import { mirroredRuleSource } from './public-rule-mirror';
import { isJsonObject } from './types';

type Loader = (capability: string) => Promise<string>;
const loadNodes: Loader = async capability => (await managedProxySource(capability)).yaml;
const MAX_PORTABLE_BYTES = 8 * 1024 * 1024;

function portableCapability(value: unknown, origin: string, kind: 'rules' | 'proxies') {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.origin !== origin || url.search || url.hash) return null;
  const match = /^\/api\/proxy-source\/([\w.-]+)\/(rules|proxies)\.yaml$/.exec(url.pathname);
  if (match?.[2] !== kind) return null;
  return match[1];
}

export async function portableMihomoYaml(
  yaml: string, origin: string,
  sourceReaders: { nodes: Loader; rules: Loader } = { nodes: loadNodes, rules: mirroredRuleSource }
) {
  const config = parse(yaml);
  const tasks: Array<() => Promise<void>> = [];
  let sourceBytes = 0;
  const countBytes = (text: string) => {
    sourceBytes += Buffer.byteLength(text);
    if (sourceBytes > MAX_PORTABLE_BYTES) throw new HttpError(409, '托管来源总大小超出单文件订阅限制。');
    return text;
  };
  for (const section of ['proxy-providers', 'rule-providers'] as const) {
    const providers = config[section] ?? {};
    const kind = section === 'proxy-providers' ? 'proxies' : 'rules';
    for (const [name, provider] of Object.entries(providers)) {
      if (!isJsonObject(provider)) throw new HttpError(409, '来源配置格式无效。');
      if (provider.type === 'inline') continue;
      const capability = provider.type === 'http' ? portableCapability(provider.url, origin, kind) : null;
      if (!capability) throw new HttpError(409, '此配置含本地文件或非托管来源，无法生成单文件订阅。');
      tasks.push(async () => {
        if (kind === 'proxies') {
          const payload: unknown = parse(countBytes(await sourceReaders.nodes(capability)))?.proxies;
          if (!Array.isArray(payload) || !payload.length || !payload.every(isJsonObject)) throw new HttpError(502, '托管代理源没有可用节点。');
          const { url, path, interval, proxy, header, 'size-limit': sizeLimit, ...settings } = provider;
          providers[name] = { ...settings, type: 'inline', payload };
        } else {
          const text = countBytes(await sourceReaders.rules(capability));
          const payload: unknown = provider.format === 'text'
            ? text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
            : parse(text)?.payload;
          if (!Array.isArray(payload) || !payload.length || !payload.every(line => typeof line === 'string')) {
            throw new HttpError(502, '托管规则集没有可用规则。');
          }
          providers[name] = { type: 'inline', behavior: provider.behavior, payload };
        }
      });
    }
  }
  if (tasks.length > 24) throw new HttpError(409, '单文件订阅最多支持 24 个托管来源。');
  for (let start = 0; start < tasks.length; start += 8) {
    try {
      await Promise.all(tasks.slice(start, start + 8).map(task => task()));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '暂时无法生成完整的单文件订阅。');
    }
  }
  const result = stringify(config, { lineWidth: 0 });
  if (Buffer.byteLength(result) > MAX_PORTABLE_BYTES) throw new HttpError(409, '单文件订阅超出大小限制。');
  return result;
}
