import type { ProxyRewriteValue } from './types';

export const PROXY_REWRITE_SHORTCUTS = ['udp', 'udp-over-tcp', 'tfo'] as const;
export const PROXY_REWRITE_FIELD_PATTERN = '[A-Za-z0-9_][A-Za-z0-9_\\-]{0,63}';
export const PROXY_REWRITE_VALUE_MAX = 4096;
export const PROXY_REWRITE_FIELD_ERROR = '请输入 1–64 个字母、数字、下划线或连字符（首字符不能是连字符）。name、type 和对象保留字段不可改写。';

const fieldPattern = new RegExp(`^${PROXY_REWRITE_FIELD_PATTERN}$`);
const reserved = new Set(['name', 'type', '__proto__', 'constructor', 'prototype']);

export function isRewriteShortcut(field: string) {
  return PROXY_REWRITE_SHORTCUTS.some(shortcut => shortcut === field);
}

export function isProxyRewriteField(field: string) {
  return fieldPattern.test(field) && !reserved.has(field.toLowerCase());
}

export function isProxyRewriteValue(value: unknown): value is ProxyRewriteValue {
  return typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= PROXY_REWRITE_VALUE_MAX);
}
