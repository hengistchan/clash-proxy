import { isIP } from 'node:net';
import type { Snapshot, StashRule, ValidationIssue } from './types';

export interface MatchInput {
  host?: string;
  ip?: string;
  network?: string;
  protocol?: string;
  process?: string;
  port?: number;
}
export type MatchState = 'yes' | 'no' | 'unknown';

function addressBits(address: string): { value: bigint; size: number } | null {
  address = address.split('%')[0];
  const version = isIP(address);
  if (!version) return null;
  if (version === 4)
    return {
      value: address.split('.').reduce((n, v) => (n << 8n) + BigInt(v), 0n),
      size: 32
    };
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    const ipv4 = addressBits(text.slice(index + 1))!;
    text =
      text.slice(0, index + 1) +
      (ipv4.value >> 16n).toString(16) +
      ':' +
      (ipv4.value & 65535n).toString(16);
  }
  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
  return {
    value: words.reduce((n, v) => (n << 16n) + BigInt('0x' + v), 0n),
    size: 128
  };
}
export function cidrContains(outer: string, inner: string): boolean {
  const [outerIp, outerMask] = outer.split('/');
  const [innerIp, innerMask] = inner.split('/');
  const a = addressBits(outerIp),
    b = addressBits(innerIp);
  if (!a || !b || a.size !== b.size) return false;
  const prefix = outerMask === undefined ? a.size : Number(outerMask);
  const subPrefix = innerMask === undefined ? b.size : Number(innerMask);
  if (
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > a.size ||
    !Number.isInteger(subPrefix) ||
    subPrefix < prefix ||
    subPrefix > b.size
  )
    return false;
  const shift = BigInt(a.size - prefix);
  return a.value >> shift === b.value >> shift;
}
function glob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
function domainEntry(value: string, host: string): boolean {
  const entry = value.toLowerCase().replace(/\.$/, '');
  if (entry.startsWith('+.'))
    return host === entry.slice(2) || host.endsWith('.' + entry.slice(2));
  if (entry.startsWith('.')) return host.endsWith(entry);
  return glob(entry, host);
}
export function matchesRule(
  rule: Pick<StashRule, 'type' | 'payload'>,
  input: MatchInput,
  snapshot: Snapshot
): MatchState {
  const host = input.host?.toLowerCase().replace(/\.$/, '');
  const payload = rule.payload.toLowerCase();
  const result = (value: boolean): MatchState => (value ? 'yes' : 'no');
  switch (rule.type) {
    case 'MATCH':
      return 'yes';
    case 'DOMAIN':
      return host ? result(host === payload) : 'unknown';
    case 'DOMAIN-SUFFIX':
      return host
        ? result(host === payload || host.endsWith('.' + payload))
        : 'unknown';
    case 'DOMAIN-KEYWORD':
      return host ? result(host.includes(payload)) : 'unknown';
    case 'DOMAIN-WILDCARD':
      return host ? result(glob(payload, host)) : 'unknown';
    case 'IP-CIDR':
    case 'IP-CIDR6':
      return input.ip
        ? result(cidrContains(rule.payload, input.ip))
        : 'unknown';
    case 'NETWORK':
      return input.network
        ? result(input.network.toLowerCase() === payload)
        : 'unknown';
    case 'PROTOCOL':
      return input.protocol
        ? result(input.protocol.toLowerCase() === payload)
        : 'unknown';
    case 'DST-PORT': {
      if (!input.port) return 'unknown';
      const [from, to] = rule.payload.split('-').map(Number);
      return result(input.port >= from && input.port <= (to ?? from));
    }
    case 'PROCESS-NAME':
    case 'PROCESS-PATH':
      if (['ios', 'tvos'].includes(snapshot.profile.targetPlatform))
        return 'no';
      return input.process
        ? result(glob(rule.payload, input.process))
        : 'unknown';
    case 'RULE-SET': {
      const provider = snapshot.ruleProviders.find(
        (item) => item.name === rule.payload
      );
      if (!provider || provider.providerType !== 'inline') return 'unknown';
      if (provider.behavior === 'domain')
        return host
          ? result(provider.entries.some((e) => domainEntry(e.value, host)))
          : 'unknown';
      if (provider.behavior === 'ipcidr')
        return input.ip
          ? result(
              provider.entries.some((e) => cidrContains(e.value, input.ip!))
            )
          : 'unknown';
      return 'unknown';
    }
    default:
      return 'unknown';
  }
}
export function simulateRouting(snapshot: Snapshot, input: MatchInput) {
  if (snapshot.profile.mode !== 'rule')
    return {
      mode: snapshot.profile.mode,
      conclusive: true,
      candidate: null,
      uncertainRules: [],
      explanation:
        snapshot.profile.mode === 'direct'
          ? '当前为直连模式，路由规则不参与决策。'
          : '当前为全局模式，出口由 Stash 的全局策略决定。'
    };
  const uncertainRules: Array<{ id: number; priority: number; type: string }> =
    snapshot.rules
      .filter((r) => r.enabled && r.options.includes('pre-matching'))
      .map((r) => ({ id: r.id, priority: r.priority, type: 'pre-matching' }));
  for (const rule of [...snapshot.rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority)) {
    if (rule.options.includes('pre-matching')) continue;
    const match = matchesRule(rule, input, snapshot);
    if (match === 'unknown')
      uncertainRules.push({
        id: rule.id,
        priority: rule.priority,
        type: rule.type
      });
    if (match === 'yes')
      return {
        mode: 'rule',
        candidate: rule,
        conclusive: uncertainRules.length === 0,
        uncertainRules,
        explanation: uncertainRules.length
          ? '这是本地可确定匹配的第一条候选；前面的规则缺少输入或依赖远程数据，实际首条命中仍需 Stash 验证。'
          : '按当前顺序，这是第一条命中的规则。'
      };
  }
  return {
    mode: 'rule',
    candidate: null,
    conclusive: uncertainRules.length === 0,
    uncertainRules,
    explanation: '没有可确定的匹配结果。'
  };
}

function terms(
  rule: StashRule,
  snapshot: Snapshot
): Array<{ type: string; value: string }> {
  if (rule.type !== 'RULE-SET')
    return [{ type: rule.type, value: rule.payload.toLowerCase() }];
  const provider = snapshot.ruleProviders.find((p) => p.name === rule.payload);
  if (!provider || provider.providerType !== 'inline') return [];
  return provider.entries.slice(0, 2000).map((e) => {
    const suffix = e.value.startsWith('+.');
    return {
      type:
        provider.behavior === 'ipcidr'
          ? 'IP-CIDR'
          : suffix
            ? 'DOMAIN-SUFFIX'
            : e.value.includes('*')
              ? 'UNKNOWN'
              : 'DOMAIN',
      value: (suffix ? e.value.slice(2) : e.value).toLowerCase()
    };
  });
}
function contains(
  a: { type: string; value: string },
  b: { type: string; value: string }
): boolean {
  if (
    a.type === 'DOMAIN-SUFFIX' &&
    ['DOMAIN', 'DOMAIN-SUFFIX'].includes(b.type)
  )
    return b.value === a.value || b.value.endsWith('.' + a.value);
  if (
    ['IP-CIDR', 'IP-CIDR6'].includes(a.type) &&
    ['IP-CIDR', 'IP-CIDR6'].includes(b.type)
  )
    return cidrContains(a.value, b.value);
  return a.type === 'DOMAIN' && b.type === 'DOMAIN' && a.value === b.value;
}
export function analyzeOrder(snapshot: Snapshot): ValidationIssue[] {
  if (snapshot.profile.mode !== 'rule') return [];
  const issues: ValidationIssue[] = [];
  const rules = [...snapshot.rules]
    .filter(
      (r) =>
        r.enabled && r.type !== 'MATCH' && !r.options.includes('pre-matching')
    )
    .sort((a, b) => a.priority - b.priority);
  const previous: Array<{ rule: StashRule; terms: ReturnType<typeof terms> }> =
    [];
  let budget = 100000;
  for (const rule of rules) {
    const current = terms(rule, snapshot);
    for (const earlier of previous) {
      if (budget <= 0 || !current.length) break;
      if (!earlier.terms.length) continue;
      let overlap = false,
        covered = 0;
      for (const term of current) {
        const found = earlier.terms.some((a) => {
          if (--budget < 0) return false;
          return contains(a, term);
        });
        if (found) {
          overlap = true;
          covered++;
        }
        if (budget <= 0) break;
      }
      if (overlap) {
        const provider =
          rule.type === 'RULE-SET'
            ? snapshot.ruleProviders.find((p) => p.name === rule.payload)
            : undefined;
        const fullyCovered =
          covered === current.length &&
          (!provider || provider.entries.length <= 2000);
        issues.push({
          severity: 'warning',
          code: fullyCovered ? 'rule.covered' : 'rule.overlap',
          resource: 'rule',
          resourceId: rule.id,
          message: `第 ${rule.priority} 条规则${fullyCovered ? '全部' : '部分'}匹配范围已被第 ${earlier.rule.priority} 条覆盖；重叠流量先使用 ${earlier.rule.policy}。`
        });
        break;
      }
    }
    previous.push({ rule, terms: current });
  }
  if (budget <= 0)
    issues.push({
      severity: 'info',
      code: 'analysis.limit',
      message: '规则规模较大，覆盖分析达到上限；未检查的范围不能视为无冲突。'
    });
  return issues;
}
