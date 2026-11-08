import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError } from './http';
import { validateSubscriptionUrl } from './provider-source';
import { PROXY_GROUP_TYPES, RULE_TYPES, RULE_OPTIONS, type JsonObject, type ProxyGroupType } from './types';
import type { ImportedDocument } from './yaml-import';

type Line = { text: string; number: number };
const sectionHeader = /^\[([a-z][a-z\d -]{0,40})\]$/i;
const nativeSections = new Set(['url rewrite', 'header rewrite', 'body rewrite', 'script', 'mitm', 'map local']);
export const unsafeConfLine = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u;

export function isShadowrocketDocument(text: string) {
  const first = text.replace(/^\ufeff/, '').split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && !/^(#|;|\/\/)/.test(line));
  return Boolean(first && /^\[(General|Proxy|Proxy Group|Rule|Host|URL Rewrite|Script|MITM)\]$/i.test(first));
}

function invalid(line: Line, message: string): never {
  throw new HttpError(400, `Shadowrocket 第 ${line.number} 行：${message}`);
}

function assignment(line: Line) {
  const index = line.text.indexOf('=');
  if (index <= 0) invalid(line, '需要“名称 = 内容”。');
  const name = line.text.slice(0, index).trim();
  const value = line.text.slice(index + 1).trim();
  if (!name || !value || name.length > 160 || /[,\[\]]/.test(name)) invalid(line, '名称或内容无效。');
  return { name, value };
}

// Native expressions may include commas inside balanced parentheses or quotes.
function tokens(value: string) {
  const parts: string[] = [];
  let start = 0, depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function optionPairs(parts: string[], line: Line) {
  const options = new Map<string, string>();
  const members: string[] = [];
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at < 0) {
      if (!part) invalid(line, '不允许空参数。');
      members.push(part);
    } else {
      const key = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (!key || !value || options.has(key)) invalid(line, '选项缺少值或重复。');
      options.set(key, value);
    }
  }
  return { options, members };
}

function boolean(value: string, line: Line) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return invalid(line, '此选项应为 true 或 false。');
}

export function parseShadowrocketDocument(text: string): ImportedDocument {
  const sections = new Map<string, { name: string; lines: Line[] }>();
  let section: { name: string; lines: Line[] } | undefined;
  const rows = text.replace(/^\ufeff/, '').split(/\r?\n/);
  if (rows.length > 60_000) throw new HttpError(400, 'Shadowrocket 配置行数过多。');
  for (const [index, raw] of rows.entries()) {
    const line = { text: raw.trim().replaceAll('\t', ' '), number: index + 1 };
    if (!line.text || /^(#|;|\/\/)/.test(line.text)) continue;
    if (unsafeConfLine.test(line.text) || line.text.length > 16384) invalid(line, '含有无效字符或内容过长。');
    const match = sectionHeader.exec(line.text);
    if (match) {
      const key = match[1].toLowerCase();
      if (sections.has(key)) invalid(line, '区块重复。');
      if (!['general', 'proxy', 'proxy group', 'rule', 'host'].includes(key) && !nativeSections.has(key)) {
        invalid(line, '暂不支持此区块，未导入以避免丢失行为。');
      }
      section = { name: match[1], lines: [] };
      sections.set(key, section);
    } else if (section) {
      section.lines.push(line);
    } else invalid(line, '配置应以区块名称开始。');
  }
  const get = (name: string) => sections.get(name)?.lines ?? [];
  if (!get('rule').length) throw new HttpError(400, 'Shadowrocket 配置缺少 [Rule]。');
  const dns: JsonObject = {};
  const general: string[] = [];
  let ipv6: boolean | null = null;
  for (const line of get('general')) {
    const { name, value } = assignment(line);
    if (name === 'include') invalid(line, '请先合并 include 引用的配置再导入。');
    if (name === 'update-url') continue; // The workbench manages the delivery URL.
    if (name === 'ipv6') ipv6 = boolean(value, line);
    else if ((name === 'dns-server' || name === 'proxy-dns-server') && tokens(value).every((item) => item === 'system' || isIP(item) || /^https:\/\/[^#,\s]+$/i.test(item))) {
      dns[name === 'dns-server' ? 'nameserver' : 'proxy-server-nameserver'] = tokens(value);
    } else general.push(line.text);
  }
  const proxies: ImportedDocument['proxies'] = get('proxy').map((line) => {
    const { name, value } = assignment(line);
    const [type, server, rawPort, ...parts] = tokens(value);
    const port = Number(rawPort);
    if (!['ss', 'socks5', 'http'].includes(type) || !server || !Number.isInteger(port) || port < 1 || port > 65535) {
      invalid(line, '暂只支持 SS、SOCKS5 和 HTTP 节点，且地址和端口必须有效。');
    }
    const config: JsonObject = { server, port };
    const { options, members } = optionPairs(parts, line);
    if (members.length) {
      if (type === 'ss' || members.length !== 2 || options.has('username') || options.has('password')) invalid(line, '无法识别节点认证参数。');
      config.username = members[0];
      config.password = members[1];
    }
    for (const [key, item] of options) {
      if (key === 'password' || key === 'username') config[key] = item;
      else if (key === 'encrypt-method' && type === 'ss') config.cipher = item;
      else if (key === 'udp-relay' && type === 'ss') config.udp = boolean(item, line);
      else if ((key === 'obfs' || key === 'obfs-host') && type === 'ss') continue;
      else invalid(line, '节点包含暂不支持的协议参数。');
    }
    if (options.has('obfs') || options.has('obfs-host')) {
      const mode = options.get('obfs');
      if (mode !== 'http' && mode !== 'tls') invalid(line, '仅支持 HTTP/TLS simple-obfs。');
      config.plugin = 'obfs';
      config['plugin-opts'] = { mode, ...(options.has('obfs-host') ? { host: options.get('obfs-host')! } : {}) };
    }
    return { name, type, config };
  });
  const groupLines = get('proxy group').map((line) => ({ ...assignment(line), line }));
  const policies = new Set([...proxies.map((node) => node.name), ...groupLines.map((entry) => entry.name)]);
  if (policies.size !== proxies.length + groupLines.length) throw new HttpError(400, 'Shadowrocket 节点和策略组名称必须唯一。');
  const commonPolicies = new Set([...policies, 'DIRECT', 'REJECT']);
  const proxyGroups: ImportedDocument['proxyGroups'] = groupLines.map(({ name, value, line }) => {
    const [type, ...parts] = tokens(value);
    if (!PROXY_GROUP_TYPES.includes(type as ProxyGroupType) || type === 'relay') invalid(line, '策略组类型暂不支持。');
    const { options, members } = optionPairs(parts, line);
    const config: JsonObject = {};
    const native: JsonObject = {};
    if (members.some((member) => member.includes('://'))) invalid(line, '策略组成员必须使用节点或订阅名称，不能直接填 URL。');
    for (const [key, item] of options) {
      if (['policy-regex-filter', 'policy-select-name'].includes(key)) native[key] = item;
      else if (key === 'use') native.use = boolean(item, line);
      else if (['interval', 'timeout', 'tolerance', 'select'].includes(key) && /^\d{1,6}$/.test(item)) {
        if (key === 'select') native.select = Number(item);
        else config[key === 'timeout' ? 'benchmark-timeout' : key] = Number(item);
      } else if (key === 'url') config.url = item;
      else if (key === 'hidden') config.hidden = boolean(item, line);
      else invalid(line, '策略组包含暂不支持的选项。');
    }
    if (native.use === true || members.some((item) => !commonPolicies.has(item))) native.nativeMembers = members;
    config.proxies = native.use === true ? [] : members.filter((item) => commonPolicies.has(item));
    if (type === 'load-balance') config.strategy = 'consistent-hashing';
    return { name, type: type as ProxyGroupType, config, ...(Object.keys(native).length ? { clientOptions: { shadowrocket: native } } : {}) };
  });
  const ruleProviders: ImportedDocument['ruleProviders'] = [];
  const rules: ImportedDocument['rules'] = get('rule').map((line) => {
    const [original, first, second, ...options] = tokens(line.text);
    const type = original.toUpperCase();
    if (type === 'FINAL') {
      if (!first || second !== undefined) invalid(line, 'FINAL 只接受一个策略。');
      return { type: 'MATCH', payload: '', policy: first, options: [], enabled: true, note: '' };
    }
    if (!first || !second || options.some((option) => !RULE_OPTIONS.includes(option as (typeof RULE_OPTIONS)[number]))) invalid(line, '规则条件、策略或选项无效。');
    if (type === 'RULE-SET' || type === 'DOMAIN-SET') {
      const remote = /^https?:\/\//i.test(first);
      if (!remote && !/^[\p{L}\p{N}_./ -]+$/u.test(first)) invalid(line, '规则集路径无效。');
      if (remote) {
        try { validateSubscriptionUrl(first); } catch { invalid(line, '规则集 URL 无效。'); }
      }
      const name = `sr-${createHash('sha256').update(type + '\u0000' + first).digest('hex').slice(0, 16)}`;
      if (!ruleProviders.some((provider) => provider.name === name)) ruleProviders.push({
        name, displayName: `Shadowrocket ${ruleProviders.length + 1}`,
        behavior: type === 'DOMAIN-SET' ? 'domain' : 'classical',
        providerType: remote ? 'remote' : 'local',
        config: { ...(remote ? { url: first } : { path: first }), format: 'text' },
        entries: [], clientOptions: { shadowrocket: { referenceType: type } }
      });
      return { type: 'RULE-SET', payload: name, policy: second, options, enabled: true, note: '' };
    }
    if (!RULE_TYPES.includes(type as (typeof RULE_TYPES)[number]) || type === 'MATCH') invalid(line, '暂不支持该规则类型。');
    return { type, payload: first, policy: second, options, enabled: true, note: '' };
  });
  if (rules.filter((rule) => rule.type === 'MATCH').length !== 1 || rules.at(-1)?.type !== 'MATCH') {
    throw new HttpError(400, 'Shadowrocket [Rule] 必须以唯一的 FINAL 结尾。');
  }
  const hosts = get('host').map((line) => {
    const { name, value } = assignment(line);
    if (!isIP(value) || name.includes('*')) invalid(line, '暂只支持精确域名到单个 IP 的 Hosts 映射。');
    return { pattern: name, value };
  });
  return {
    mode: 'rule', logLevel: 'silent', ipv6, settings: { dns },
    clientOptions: { shadowrocket: { native: true, general, sections: [...sections].filter(([key]) => nativeSections.has(key))
      .map(([, value]) => ({ name: value.name, lines: value.lines.map((line) => line.text) })) } },
    proxies, proxyProviders: [], proxyGroups, ruleProviders, rules, hosts, advancedSections: []
  };
}
