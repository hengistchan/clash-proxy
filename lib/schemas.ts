import { z } from 'zod';

import { type JsonObject, type JsonValue, isJsonObject } from './types';

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

const jsonObject = z.custom<JsonObject>(isJsonObject, {
  message: 'Expected a JSON object'
});
const jsonValue = z.custom<JsonValue>(isJsonValue, {
  message: 'Expected a JSON value'
});

const name = z.string().trim().min(1).max(160);

export const profileCreateSchema = z.object({
  name,
  importYaml: z.string().optional(),
  example: z.boolean().default(false)
});

export const profileUpdateSchema = z.object({
  name: name.optional(),
  active: z.boolean().optional()
});

export const settingsSchema = z.object({
  mode: z.enum(['rule', 'global', 'direct']),
  logLevel: z.enum(['silent', 'info', 'warning', 'error', 'debug']),
  ipv6: z.boolean().nullable().optional(),
  settings: jsonObject,
  targetPlatform: z.enum(['any', 'ios', 'tvos', 'macos']).optional()
});

export const proxySchema = z.object({
  name,
  type: z.string().trim().min(1).max(64),
  config: jsonObject.default({})
});

export const proxyProviderSchema = z.object({
  name,
  config: jsonObject.default({}),
  sourceType: z.enum(['remote', 'local']).optional(),
  sourceUrl: z.string().max(16384).optional(),
  sourceHeaders: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
  clearSource: z.boolean().optional(),
  clearHeaders: z.boolean().optional()
});

export const proxyGroupSchema = z.object({
  name,
  type: z.enum(['select', 'url-test', 'fallback', 'load-balance', 'relay']),
  config: jsonObject.default({})
});

export const ruleProviderSchema = z.object({
  name,
  displayName: z.string().trim().max(160).optional(),
  behavior: z.string().trim().min(1).max(64),
  providerType: z.enum(['inline', 'remote', 'local']),
  config: jsonObject.default({}),
  entries: z.array(z.string()).default([]),
  sourceUrl: z.string().max(16384).optional(),
  sourceHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  clearSource: z.boolean().optional(),
  clearHeaders: z.boolean().optional()
});

export const ruleSchema = z.object({
  type: z.string().trim().min(1),
  payload: z.string().default(''),
  policy: z.string().trim().min(1),
  options: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  note: z.string().default(''),
  priority: z.number().int().positive().optional()
});

export const ruleOrderSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1)
});

export const hostSchema = z.object({
  pattern: z.string().trim().min(1).max(500),
  value: z.string().trim().min(1).max(500)
});

export const advancedSchema = z.object({
  sections: z
    .array(z.object({ key: z.string().trim().min(1), value: jsonValue }))
    .default([])
});
