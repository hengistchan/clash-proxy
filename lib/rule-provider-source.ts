import { HttpError } from './http';
import { validateSubscriptionUrl } from './provider-source';
import type { JsonObject, RuleProvider, RuleProviderType } from './types';

export interface RuleProviderInput {
  name: string;
  displayName?: string;
  behavior: string;
  providerType: RuleProviderType;
  config: JsonObject;
  entries: string[];
  sourceUrl?: string;
  sourceHeaders?: JsonObject;
  clearSource?: boolean;
  clearHeaders?: boolean;
}

const INLINE_IGNORED_FIELDS = ['url', 'path', 'format', 'interval', 'headers'];

/** Detect input that Stash would silently interpret differently from the editor. */
export function ruleProviderConflict(
  type: RuleProviderType,
  config: JsonObject,
  entries: ReadonlyArray<unknown>
): string | null {
  if (config.url !== undefined && typeof config.url !== 'string') return 'url must be a string';
  if (config.path !== undefined && typeof config.path !== 'string') return 'path must be a string';
  if (config.headers !== undefined && (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers) || !Object.values(config.headers).every((value) => typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))))) return 'headers must contain strings or string sequences';
  const expectedType = type === 'inline' ? 'inline' : type === 'remote' ? 'http' : 'file';
  if (config.type !== undefined && config.type !== expectedType) {
    return 'source type conflicts with config.type';
  }
  if (config.payload !== undefined) return 'payload must be managed as inline entries';
  if (type !== 'inline' && entries.length) return 'file and remote sources cannot contain inline entries';
  if (type === 'inline' && INLINE_IGNORED_FIELDS.some((key) => config[key] !== undefined)) {
    return 'inline sources cannot contain remote or file source fields';
  }
  if (type === 'local' && ['url', 'headers', 'interval'].some((key) => config[key] !== undefined)) {
    return 'local sources cannot contain remote source fields';
  }
  return null;
}

/** Credential changes are explicit; ordinary edits preserve an existing remote source. */
export function ruleProviderConfig(input: RuleProviderInput, current: JsonObject = {}): JsonObject {
  const config = { ...input.config };
  const conflict = ruleProviderConflict(input.providerType, config, input.entries);
  if (conflict) throw new HttpError(400, `Rule provider ${conflict}`);
  if (config.behavior !== undefined && config.behavior !== input.behavior) {
    throw new HttpError(400, 'Rule provider behavior conflicts with config.behavior');
  }
  if (input.providerType !== 'remote' && (input.sourceUrl !== undefined || input.sourceHeaders !== undefined)) {
    throw new HttpError(400, 'Only remote rule providers can receive source credentials');
  }
  delete config.type;
  delete config.behavior;
  if (input.providerType === 'remote') {
    if (input.clearSource) delete config.url;
    else if (input.sourceUrl !== undefined) config.url = validateSubscriptionUrl(input.sourceUrl);
    else if (typeof config.url === 'string') config.url = validateSubscriptionUrl(config.url);
    else if (current.url !== undefined) config.url = current.url;
    if (input.clearHeaders) delete config.headers;
    else if (input.sourceHeaders !== undefined) config.headers = input.sourceHeaders;
    else if (config.headers === undefined && current.headers !== undefined) config.headers = current.headers;
  }
  if (config.headers !== undefined) {
    if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers) ||
      !Object.values(config.headers).every((value) => typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))) {
      throw new HttpError(400, 'Rule provider headers must contain strings or string sequences');
    }
  }
  return config;
}

export function publicRuleProvider(provider: RuleProvider): RuleProvider {
  const config = { ...provider.config };
  delete config.url;
  delete config.headers;
  return { ...provider, config };
}

/** Produce Stash's canonical representation after successful validation. */
export function exportRuleProvider(provider: RuleProvider): JsonObject {
  if (provider.providerType === 'inline') {
    return { type: 'inline', behavior: provider.behavior, payload: provider.entries.map((entry) => entry.value) };
  }
  const config: JsonObject = { ...provider.config, behavior: provider.behavior };
  delete config.type;
  delete config.payload;
  return config;
}
