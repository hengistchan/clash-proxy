import type Database from 'better-sqlite3';

import { decryptResource, decryptResourceObject, encryptResource, readClientOptions, storeMatchType } from './config-storage-model';
import { HttpError } from './http';
import { ruleSetNames } from './rules';
import type { JsonObject, JsonValue, ProxyGroup, Snapshot } from './types';
import { isJsonObject } from './types';
import { getProfileRow } from './repository-shared';

function deepReplaceString(
  value: JsonValue,
  replacement: (input: string) => string
): JsonValue {
  if (typeof value === 'string') return replacement(value);
  if (Array.isArray(value))
    return value.map((item) => deepReplaceString(item, replacement));
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        replacement(key),
        deepReplaceString(item, replacement)
      ])
    );
  }
  return value;
}

function replaceRuleSetReference(
  input: string,
  oldName: string,
  newName: string
): string {
  if (input.startsWith('rule-set:'))
    return (
      'rule-set:' +
      ruleSetNames(input)
        .map((name) => (name === oldName ? newName : name))
        .join(',')
    );
  return input.replaceAll(`RULE-SET,${oldName},`, `RULE-SET,${newName},`);
}

export function rewriteRenamedResource(
  db: Database.Database,
  profileId: number,
  kind: string,
  oldName: string,
  newName: string
): void {
  if (kind === 'proxy-providers') {
    const groups = db
      .prepare(
        'SELECT id, config_ciphertext FROM proxy_groups WHERE profile_id = ?'
      )
      .all(profileId) as Record<string, unknown>[];
    for (const group of groups) {
      const config = decryptResourceObject('policyGroup', group.config_ciphertext);
      const use = Array.isArray(config.use)
        ? config.use.map((item) =>
            String(item) === oldName ? newName : String(item)
          )
        : config.use;
      if (Array.isArray(use) && use.some((item) => String(item) === newName)) {
        db.prepare(
          'UPDATE proxy_groups SET config_ciphertext = ? WHERE id = ?'
        ).run(encryptResource('policyGroup', { ...config, use }, readClientOptions(group.config_ciphertext)), Number(group.id));
      }
    }
    return;
  }

  if (kind === 'rule-providers') {
    db.prepare(
      'UPDATE rules SET payload = ? WHERE profile_id = ? AND type = ? AND payload = ?'
    ).run(newName, profileId, storeMatchType('RULE-SET'), oldName);
    const profile = getProfileRow(db, profileId);
    const settings = decryptResourceObject('settings', profile.settings_ciphertext);
    const changed = deepReplaceString(settings, (value) =>
      replaceRuleSetReference(value, oldName, newName)
    );
    db.prepare('UPDATE profiles SET settings_ciphertext = ? WHERE id = ?').run(
      encryptResource('settings', changed, readClientOptions(profile.settings_ciphertext)),
      profileId
    );
    const advanced = db
      .prepare(
        'SELECT id, value_ciphertext FROM advanced_sections WHERE profile_id = ?'
      )
      .all(profileId) as Record<string, unknown>[];
    for (const section of advanced) {
      const value = decryptResource('extension', section.value_ciphertext);
      const next = deepReplaceString(value, (item) =>
        replaceRuleSetReference(item, oldName, newName)
      );
      db.prepare(
        'UPDATE advanced_sections SET value_ciphertext = ? WHERE id = ?'
      ).run(encryptResource('extension', next), Number(section.id));
    }
    return;
  }

  if (kind === 'proxies' || kind === 'proxy-groups') {
    db.prepare(
      'UPDATE rules SET policy = ? WHERE profile_id = ? AND policy = ?'
    ).run(newName, profileId, oldName);
    const groups = db
      .prepare(
        'SELECT id, config_ciphertext FROM proxy_groups WHERE profile_id = ?'
      )
      .all(profileId) as Record<string, unknown>[];
    for (const group of groups) {
      const config = decryptResourceObject('policyGroup', group.config_ciphertext);
      const options = readClientOptions(group.config_ciphertext);
      const native = options?.shadowrocket;
      let changed = false;
      const updated = { ...config };
      if (native && Array.isArray(native.nativeMembers) && native.nativeMembers.includes(oldName)) {
        native.nativeMembers = native.nativeMembers.map((member) => member === oldName ? newName : member);
        changed = true;
      }
      if (native?.['policy-select-name'] === oldName) {
        native['policy-select-name'] = newName;
        changed = true;
      }
      if (Array.isArray(config.proxies)) {
        updated.proxies = config.proxies.map((item) => {
          if (String(item) === oldName) {
            changed = true;
            return newName;
          }
          return item;
        });
      }
      if (isJsonObject(config['ssid-policy'])) {
        const policy = { ...config['ssid-policy'] };
        for (const [ssid, target] of Object.entries(policy)) {
          if (String(target) === oldName) {
            policy[ssid] = newName;
            changed = true;
          }
        }
        updated['ssid-policy'] = policy;
      }
      if (changed) {
        db.prepare(
          'UPDATE proxy_groups SET config_ciphertext = ? WHERE id = ?'
        ).run(encryptResource('policyGroup', updated, options), Number(group.id));
      }
    }
  }
}

export function collectReferences(
  snapshot: Snapshot,
  kind: string,
  name: string
): string[] {
  const references = new Set<string>();
  const groupUses = (group: ProxyGroup) =>
    Array.isArray(group.config.use) ? group.config.use.map(String) : [];
  const groupMembers = (group: ProxyGroup) =>
    Array.isArray(group.config.proxies) ? group.config.proxies.map(String) : [];
  const ssidPolicyTargets = (group: ProxyGroup) =>
    isJsonObject(group.config['ssid-policy'])
      ? Object.entries(group.config['ssid-policy']).map(([ssid, target]) => ({
          ssid,
          target: String(target)
        }))
      : [];

  if (kind === 'proxy-providers') {
    for (const group of snapshot.proxyGroups) {
      if (groupUses(group).includes(name)) {
        references.add(
          `strategy group “${group.name}” uses provider “${name}”`
        );
      }
    }
  } else if (kind === 'proxies' || kind === 'proxy-groups') {
    for (const group of snapshot.proxyGroups) {
      if (groupMembers(group).includes(name)) {
        references.add(`strategy group “${group.name}” contains “${name}”`);
      }
      const native = group.clientOptions?.shadowrocket;
      if ((Array.isArray(native?.nativeMembers) && native.nativeMembers.includes(name)) ||
        native?.['policy-select-name'] === name) {
        references.add(`Shadowrocket strategy group “${group.name}” references “${name}”`);
      }
      for (const entry of ssidPolicyTargets(group)) {
        if (entry.target === name) {
          references.add(
            `strategy group “${group.name}” SSID policy “${entry.ssid}” targets “${name}”`
          );
        }
      }
    }
    for (const rule of snapshot.rules) {
      if (rule.policy === name) {
        references.add(`rule priority ${rule.priority} targets “${name}”`);
      }
    }
  } else if (kind === 'rule-providers') {
    for (const rule of snapshot.rules) {
      if (rule.type === 'RULE-SET' && rule.payload === name) {
        references.add(
          `rule priority ${rule.priority} references rule set “${name}”`
        );
      }
    }
    const scan = (value: JsonValue): boolean => {
      if (typeof value === 'string') {
        return ruleSetNames(value).includes(name);
      }
      if (Array.isArray(value)) return value.some((item) => scan(item));
      if (isJsonObject(value))
        return Object.entries(value).some(
          ([key, item]) => scan(key) || scan(item)
        );
      return false;
    };
    if (scan(snapshot.profile.settings)) {
      references.add(`DNS settings reference rule set “${name}”`);
    }
    for (const section of snapshot.advancedSections) {
      if (scan(section.value)) {
        references.add(
          `advanced section “${section.key}” references rule set “${name}”`
        );
      }
    }
  }
  return [...references];
}

export function assertNoReferences(
  snapshot: Snapshot,
  kind: string,
  name: string
): void {
  const references = collectReferences(snapshot, kind, name);
  if (references.length) {
    throw new HttpError(
      409,
      `Resource is still referenced: ${references.join('; ')}`
    );
  }
}
