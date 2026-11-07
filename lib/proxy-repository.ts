import type Database from 'better-sqlite3';

import { transaction } from './db';
import { encryptJson } from './crypto';
import { HttpError } from './http';
import { validateSubscriptionUrl } from './provider-source';
import type {
  JsonObject,
  ProxyGroup,
  ProxyGroupType,
  ProxyNode,
  ProxyProvider
} from './types';
import {
  assertPolicyNameAvailable,
  assertUniqueName,
  decryptObject,
  getProfileRow,
  mapProxy,
  mapProxyGroup,
  mapProxyProvider,
  nextSortOrder,
  publicProvider,
  snapshotFromDb
} from './repository-shared';
import { assertNoReferences, rewriteRenamedResource } from './resource-references';

interface ProxyProviderInput {
  name: string;
  config: JsonObject;
  sourceType?: 'remote' | 'local';
  sourceUrl?: string;
  sourceHeaders?: JsonObject;
  clearSource?: boolean;
  clearHeaders?: boolean;
}

function providerConfig(
  input: ProxyProviderInput,
  current: JsonObject = {}
): JsonObject {
  const config = { ...input.config };
  if (input.clearSource) delete config.url;
  else if (input.sourceUrl !== undefined)
    config.url = validateSubscriptionUrl(input.sourceUrl);
  else if (typeof config.url === 'string')
    config.url = validateSubscriptionUrl(config.url);
  else if (current.url) config.url = current.url;
  if (input.clearHeaders) delete config.headers;
  else if (input.sourceHeaders !== undefined)
    config.headers = input.sourceHeaders;
  else if (config.headers === undefined && current.headers)
    config.headers = current.headers;
  if (input.sourceType === 'local') delete config.url;
  return config;
}

export function createProxyRepository({
  ensureInitialized,
  recordRevision
}: {
  ensureInitialized: () => void;
  recordRevision: (db: Database.Database, profileId: number) => number;
}) {
  function createProxy(
    profileId: number,
    input: { name: string; type: string; config: JsonObject }
  ): ProxyNode {
    ensureInitialized();
    return transaction((db) => {
      getProfileRow(db, profileId);
      assertUniqueName(db, 'proxies', profileId, input.name);
      assertPolicyNameAvailable(db, profileId, input.name, 'proxies');
      const order = nextSortOrder(db, 'proxies', profileId);
      const result = db
        .prepare(
          `INSERT INTO proxies (profile_id, name, type, config_ciphertext, sort_order)
         VALUES (?, ?, ?, ?, ?)`
        )
        .run(profileId, input.name, input.type, encryptJson(input.config), order);
      recordRevision(db, profileId);
      return mapProxy(
        db
          .prepare('SELECT * FROM proxies WHERE id = ?')
          .get(result.lastInsertRowid) as Record<string, unknown>
      );
    });
  }

  function updateProxy(
    profileId: number,
    itemId: number,
    input: { name: string; type: string; config: JsonObject }
  ): ProxyNode {
    ensureInitialized();
    return transaction((db) => {
      const current = db
        .prepare('SELECT * FROM proxies WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!current) throw new HttpError(404, 'Direct proxy not found');
      assertUniqueName(db, 'proxies', profileId, input.name, itemId);
      assertPolicyNameAvailable(db, profileId, input.name, 'proxies');
      const oldName = String(current.name);
      db.prepare(
        'UPDATE proxies SET name = ?, type = ?, config_ciphertext = ? WHERE id = ?'
      ).run(input.name, input.type, encryptJson(input.config), itemId);
      if (oldName !== input.name) {
        rewriteRenamedResource(db, profileId, 'proxies', oldName, input.name);
      }
      recordRevision(db, profileId);
      return mapProxy(
        db.prepare('SELECT * FROM proxies WHERE id = ?').get(itemId) as Record<
          string,
          unknown
        >
      );
    });
  }

  function deleteProxy(profileId: number, itemId: number): void {
    ensureInitialized();
    transaction((db) => {
      const row = db
        .prepare('SELECT * FROM proxies WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!row) throw new HttpError(404, 'Direct proxy not found');
      const snapshot = snapshotFromDb(db, profileId);
      assertNoReferences(snapshot, 'proxies', String(row.name));
      db.prepare('DELETE FROM proxies WHERE id = ?').run(itemId);
      recordRevision(db, profileId);
    });
  }

  function createProxyProvider(
    profileId: number,
    input: ProxyProviderInput
  ): ProxyProvider {
    ensureInitialized();
    return transaction((db) => {
      getProfileRow(db, profileId);
      assertUniqueName(db, 'proxy_providers', profileId, input.name);
      const order = nextSortOrder(db, 'proxy_providers', profileId);
      const config = providerConfig(input);
      const requiresUrl = input.sourceType
        ? input.sourceType === 'remote'
        : Boolean(config.url) || !config.path;
      const result = db
        .prepare(
          `INSERT INTO proxy_providers
         (profile_id, name, config_ciphertext, requires_url, sort_order)
       VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          input.name,
          encryptJson(config),
          Number(requiresUrl),
          order
        );
      recordRevision(db, profileId);
      return publicProvider(
        mapProxyProvider(
          db
            .prepare('SELECT * FROM proxy_providers WHERE id = ?')
            .get(result.lastInsertRowid) as Record<string, unknown>
        )
      );
    });
  }

  function updateProxyProvider(
    profileId: number,
    itemId: number,
    input: ProxyProviderInput
  ): ProxyProvider {
    ensureInitialized();
    return transaction((db) => {
      const current = db
        .prepare('SELECT * FROM proxy_providers WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!current) throw new HttpError(404, 'Proxy provider not found');
      assertUniqueName(db, 'proxy_providers', profileId, input.name, itemId);
      const oldName = String(current.name);
      const config = providerConfig(
        input,
        decryptObject(current.config_ciphertext)
      );
      const requiresUrl = input.sourceType
        ? input.sourceType === 'remote'
        : mapProxyProvider(current).sourceType === 'remote';
      db.prepare(
        `UPDATE proxy_providers
       SET name = ?, config_ciphertext = ?, requires_url = ? WHERE id = ?`
      ).run(input.name, encryptJson(config), Number(requiresUrl), itemId);
      if (oldName !== input.name) {
        rewriteRenamedResource(
          db,
          profileId,
          'proxy-providers',
          oldName,
          input.name
        );
      }
      recordRevision(db, profileId);
      return publicProvider(
        mapProxyProvider(
          db
            .prepare('SELECT * FROM proxy_providers WHERE id = ?')
            .get(itemId) as Record<string, unknown>
        )
      );
    });
  }

  function deleteProxyProvider(profileId: number, itemId: number): void {
    ensureInitialized();
    transaction((db) => {
      const row = db
        .prepare('SELECT * FROM proxy_providers WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!row) throw new HttpError(404, 'Proxy provider not found');
      assertNoReferences(
        snapshotFromDb(db, profileId),
        'proxy-providers',
        String(row.name)
      );
      db.prepare('DELETE FROM proxy_providers WHERE id = ?').run(itemId);
      recordRevision(db, profileId);
    });
  }

  function createProxyGroup(
    profileId: number,
    input: { name: string; type: ProxyGroupType; config: JsonObject }
  ): ProxyGroup {
    ensureInitialized();
    return transaction((db) => {
      getProfileRow(db, profileId);
      assertUniqueName(db, 'proxy_groups', profileId, input.name);
      assertPolicyNameAvailable(db, profileId, input.name, 'proxy-groups');
      const order = nextSortOrder(db, 'proxy_groups', profileId);
      const result = db
        .prepare(
          `INSERT INTO proxy_groups (profile_id, name, type, config_ciphertext, sort_order)
       VALUES (?, ?, ?, ?, ?)`
        )
        .run(profileId, input.name, input.type, encryptJson(input.config), order);
      recordRevision(db, profileId);
      return mapProxyGroup(
        db
          .prepare('SELECT * FROM proxy_groups WHERE id = ?')
          .get(result.lastInsertRowid) as Record<string, unknown>
      );
    });
  }

  function updateProxyGroup(
    profileId: number,
    itemId: number,
    input: { name: string; type: ProxyGroupType; config: JsonObject }
  ): ProxyGroup {
    ensureInitialized();
    return transaction((db) => {
      const current = db
        .prepare('SELECT * FROM proxy_groups WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!current) throw new HttpError(404, 'Strategy group not found');
      assertUniqueName(db, 'proxy_groups', profileId, input.name, itemId);
      assertPolicyNameAvailable(db, profileId, input.name, 'proxy-groups');
      const oldName = String(current.name);
      db.prepare(
        'UPDATE proxy_groups SET name = ?, type = ?, config_ciphertext = ? WHERE id = ?'
      ).run(input.name, input.type, encryptJson(input.config), itemId);
      if (oldName !== input.name) {
        rewriteRenamedResource(db, profileId, 'proxy-groups', oldName, input.name);
      }
      recordRevision(db, profileId);
      return mapProxyGroup(
        db
          .prepare('SELECT * FROM proxy_groups WHERE id = ?')
          .get(itemId) as Record<string, unknown>
      );
    });
  }

  function deleteProxyGroup(profileId: number, itemId: number): void {
    ensureInitialized();
    transaction((db) => {
      const row = db
        .prepare('SELECT * FROM proxy_groups WHERE id = ? AND profile_id = ?')
        .get(itemId, profileId) as Record<string, unknown> | undefined;
      if (!row) throw new HttpError(404, 'Strategy group not found');
      assertNoReferences(
        snapshotFromDb(db, profileId),
        'proxy-groups',
        String(row.name)
      );
      db.prepare('DELETE FROM proxy_groups WHERE id = ?').run(itemId);
      recordRevision(db, profileId);
    });
  }

  return {
    createProxy,
    updateProxy,
    deleteProxy,
    createProxyProvider,
    updateProxyProvider,
    deleteProxyProvider,
    createProxyGroup,
    updateProxyGroup,
    deleteProxyGroup
  };
}
