import {
  BUILTIN_POLICIES,
  RULE_TYPES,
  type ProxyGroupType
} from './types';

type RuleType = (typeof RULE_TYPES)[number];
type BuiltinPolicy = (typeof BUILTIN_POLICIES)[number];

export const RULE_TYPE_DESCRIPTIONS = {
  DOMAIN: '精确匹配完整域名，不包含子域',
  'DOMAIN-SUFFIX': '匹配域名本身及其全部子域',
  'DOMAIN-KEYWORD': '域名中包含指定关键词时匹配',
  'DOMAIN-WILDCARD': '使用通配符匹配域名，如 *.example.com',
  'DOMAIN-REGEX': '使用正则表达式匹配完整域名',
  GEOIP: '按 IP 所属国家或地区匹配',
  'IP-ASN': '按 IP 所属自治系统编号匹配',
  'IP-CIDR': '匹配 IPv4 网段或单个 IPv4 地址',
  'IP-CIDR6': '匹配 IPv6 网段或单个 IPv6 地址',
  NETWORK: '按传输层网络类型匹配，如 tcp、udp',
  PROTOCOL: '按请求使用的应用协议类型匹配',
  'DST-PORT': '按目标端口或端口范围匹配',
  'SRC-IP': '按发起请求的来源 IP 网段匹配',
  'SRC-PORT': '按发起请求的来源端口匹配',
  'RULE-SET': '引用已创建的规则集，复用其中条目',
  GEOSITE: '按 GeoSite 分类匹配一组域名',
  'PROCESS-NAME': '按发起请求的进程名匹配',
  'PROCESS-PATH': '按发起请求的进程路径匹配',
  SCRIPT: '执行脚本并根据脚本返回结果匹配',
  AND: '括号内全部子规则同时命中时匹配',
  OR: '括号内任一子规则命中时匹配',
  NOT: '括号内子规则未命中时匹配',
  'USER-AGENT': '按 HTTP User-Agent 文本匹配',
  'URL-REGEX': '使用正则表达式匹配完整请求 URL',
  MATCH: '最终兜底规则，不填匹配内容且应放在末位'
} satisfies Record<RuleType, string>;

export const BUILTIN_POLICY_DESCRIPTIONS = {
  DIRECT: '直接连接，不经过代理节点',
  REJECT: '立即拒绝连接',
  'REJECT-DROP': '静默丢弃连接，不返回拒绝响应',
  PASS: '跳过当前路由出口，继续交给后续规则处理'
} satisfies Record<BuiltinPolicy, string>;

export const PROXY_GROUP_TYPE_DESCRIPTIONS = {
  select: '手动选择出口成员',
  'url-test': '自动选择延迟最低的可用成员',
  fallback: '按成员顺序使用首个可用节点',
  'load-balance': '将请求分摊到多个成员',
  relay: '将成员串联组成代理链'
} satisfies Record<ProxyGroupType, string>;

export function ruleTypeDescription(type: string): string {
  return (
    RULE_TYPE_DESCRIPTIONS[type as RuleType] ??
    '按该规则类型在已填写内容中匹配'
  );
}

export function builtinPolicyDescription(policy: string): string {
  return (
    BUILTIN_POLICY_DESCRIPTIONS[policy as BuiltinPolicy] ??
    'Stash 内置出口策略'
  );
}
