import { HttpError } from './http';
import {
  RULE_OPTIONS,
  RULE_TYPES,
  isJsonObject,
  type StashRule
} from './types';

export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '(' || char === '[') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

export interface ParsedRule {
  type: string;
  payload: string;
  policy: string;
  options: string[];
}

export function parseRuleLine(raw: string): ParsedRule {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HttpError(400, 'Rule text is required');
  }
  const parts = splitTopLevel(raw.trim());
  const type = parts[0].toUpperCase();
  if (!RULE_TYPES.includes(type as (typeof RULE_TYPES)[number])) {
    throw new HttpError(400, `Unsupported rule type: ${type}`);
  }
  if (type === 'MATCH') {
    if (parts.length !== 2 || !parts[1]) {
      throw new HttpError(400, 'Invalid MATCH rule');
    }
    return { type, payload: '', policy: parts[1], options: [] };
  }
  if (parts.length < 3) {
    throw new HttpError(400, 'Rule must contain type, payload, and policy');
  }
  return {
    type,
    payload: parts[1],
    policy: parts[2],
    options: parts.slice(3).filter(Boolean)
  };
}

export function serializeRule(rule: StashRule): string {
  if (rule.type === 'MATCH') {
    return `MATCH,${rule.policy}`;
  }
  const fields = [rule.type, rule.payload, rule.policy, ...rule.options];
  return fields.join(',');
}

export function normalizeRuleInput(input: {
  type: string;
  payload?: string;
  policy: string;
  options?: string[];
  enabled?: boolean;
  note?: string;
}): Omit<StashRule, 'id' | 'priority'> {
  const type = input.type.trim().toUpperCase();
  if (!RULE_TYPES.includes(type as (typeof RULE_TYPES)[number])) {
    throw new HttpError(400, `Unsupported rule type: ${type}`);
  }
  const payload = (input.payload || '').trim();
  const policy = input.policy.trim();
  if (!policy) {
    throw new HttpError(400, 'Rule policy is required');
  }
  if (type !== 'MATCH' && !payload) {
    throw new HttpError(400, 'Rule payload is required');
  }
  if (type === 'MATCH' && payload) {
    throw new HttpError(400, 'MATCH cannot have a payload');
  }
  if (payload.includes('\n') || payload.includes('\r')) {
    throw new HttpError(400, 'Rule payload cannot contain line breaks');
  }
  if (policy.includes('\n') || policy.includes('\r')) {
    throw new HttpError(400, 'Rule policy cannot contain line breaks');
  }
  const options = [
    ...new Set(
      (input.options || []).map((option) => option.trim()).filter(Boolean)
    )
  ];
  for (const option of options) {
    if (!RULE_OPTIONS.includes(option as (typeof RULE_OPTIONS)[number])) {
      throw new HttpError(400, `Unsupported rule option: ${option}`);
    }
  }
  if (type === 'MATCH' && options.length) {
    throw new HttpError(400, 'MATCH cannot have rule options');
  }
  return {
    type,
    payload,
    policy,
    options,
    enabled: input.enabled !== false,
    note: (input.note || '').trim().slice(0, 500)
  };
}

export function ruleObjectFromText(raw: string): ParsedRule {
  return parseRuleLine(raw);
}

export function isLogicalRuleType(type: string): boolean {
  return type === 'AND' || type === 'OR' || type === 'NOT';
}

export function assertJsonRulePayload(type: string, payload: string): void {
  if (!isLogicalRuleType(type)) {
    return;
  }
  const cleaned = payload.replaceAll('(', '(').replaceAll(')', ')');
  let depth = 0;
  for (const char of cleaned) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) {
      throw new HttpError(400, 'Logical rule parentheses are unbalanced');
    }
  }
  if (depth !== 0) {
    throw new HttpError(400, 'Logical rule parentheses are unbalanced');
  }
}

export function ruleListToYaml(rules: StashRule[]): string[] {
  return rules
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.priority - right.priority)
    .map(serializeRule);
}

export function isJsonConfig(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value);
}

export { ruleSetNames } from './references';
