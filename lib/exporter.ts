import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { HttpError } from './http';
import { ruleListToYaml } from './rules';
import type { JsonObject, JsonValue, Snapshot } from './types';
import { RESERVED_TOP_LEVEL_KEYS, isJsonObject } from './types';
import { validateSnapshot } from './validation';

const KNOWN_EARLY_SECTIONS = ['http', 'cron', 'script-providers', 'script'];
export interface ExportResult {
  yaml: string;
  filename: string;
  sha256: string;
  ruleCount: number;
  validation: ReturnType<typeof validateSnapshot>;
}

function mergeObject(
  base: JsonObject,
  additions: Record<string, unknown>
): JsonObject {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(additions).filter(([, value]) => value !== undefined)
    )
  } as JsonObject;
}

export function buildConfigObject(snapshot: Snapshot): {
  config: Record<string, unknown>;
  validation: ReturnType<typeof validateSnapshot>;
} {
  const validation = validateSnapshot(snapshot);
  if (!validation.valid) {
    throw new HttpError(
      409,
      'Configuration validation failed',
      validation.issues.filter((item) => item.severity === 'error')
    );
  }

  const advanced = new Map(
    snapshot.advancedSections.map((item) => [item.key, item.value])
  );
  const config: Record<string, unknown> = {};
  config.mode = snapshot.profile.mode;
  config['log-level'] = snapshot.profile.logLevel;
  if (snapshot.profile.ipv6 !== null) {
    config.ipv6 = snapshot.profile.ipv6;
  }

  for (const key of KNOWN_EARLY_SECTIONS) {
    if (advanced.has(key)) {
      config[key] = advanced.get(key);
      advanced.delete(key);
    }
  }

  if (snapshot.hosts.length) {
    config.hosts = Object.fromEntries(
      snapshot.hosts.map((item) => [item.pattern, item.value])
    );
  }

  config.dns = isJsonObject(snapshot.profile.settings.dns)
    ? snapshot.profile.settings.dns
    : {};

  if (snapshot.proxies.length) {
    config.proxies = snapshot.proxies.map((item) =>
      mergeObject(item.config, { name: item.name, type: item.type })
    );
  }

  const groups = snapshot.proxyGroups.map((item) =>
    mergeObject(item.config, { name: item.name, type: item.type })
  );
  if (groups.length) config['proxy-groups'] = groups;

  const providers = Object.fromEntries(
    snapshot.proxyProviders.map((item) => {
      const provider = { ...item.config };
      return [item.name, provider];
    })
  );
  if (Object.keys(providers).length) config['proxy-providers'] = providers;

  const ruleProviders = Object.fromEntries(
    snapshot.ruleProviders.map((item) => {
      const provider: JsonObject = {
        ...item.config,
        behavior: item.behavior
      };
      if (item.providerType === 'inline') {
        provider.type = 'inline';
        provider.payload = item.entries.map((entry) => entry.value);
      }
      return [item.name, provider];
    })
  );
  config['rule-providers'] = ruleProviders;

  config.rules = ruleListToYaml(snapshot.rules);

  for (const [key, value] of advanced) {
    config[key] = value;
  }

  return { config, validation };
}

export function exportProfile(snapshot: Snapshot): ExportResult {
  const { config, validation } = buildConfigObject(snapshot);
  const yaml = stringifyYaml(config, {
    lineWidth: 0,
    minContentWidth: 0,
    sortMapEntries: false
  });

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (error) {
    throw new HttpError(
      500,
      `Generated configuration could not be parsed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
  if (!isJsonObject(parsed)) {
    throw new HttpError(500, 'Generated configuration is not a YAML mapping');
  }
  const expectedRules = config.rules as string[];
  if (JSON.stringify(parsed.rules) !== JSON.stringify(expectedRules)) {
    throw new HttpError(500, 'Generated rule verification failed');
  }
  const sha256 = createHash('sha256').update(yaml, 'utf8').digest('hex');
  return {
    yaml,
    filename: `config-${snapshot.profile.id}.yaml`,
    sha256,
    ruleCount: expectedRules.length,
    validation
  };
}

export function reservedTopLevelKey(key: string): boolean {
  return RESERVED_TOP_LEVEL_KEYS.has(key);
}

export function stringifyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}
