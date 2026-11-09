import { createHmac } from 'node:crypto';
import { getEncryptionKey } from './crypto';
import type Database from 'better-sqlite3';
import type { ImportedDocument } from './yaml-import';
import type { Profile, Snapshot } from './types';
import { HttpError } from './http';
import { managedSourceReference, verifySourceCapability } from './managed-source-access';
import { managedSources, servedRecord } from './target-publication-store';

export type PreparedDocument = Omit<ImportedDocument, 'proxyProviders'> & {
  proxyProviders: Array<ImportedDocument['proxyProviders'][number] & { retainedId?: number }>;
};

/** Resolve bindings once, for both static preview and the subsequent checked write. */
export function prepareImport(
  db: Database.Database | undefined, profileId: number, document: ImportedDocument, current: Snapshot | undefined,
  intent: 'new' | 'replace' | 'restore'
): PreparedDocument {
  const byName = new Map(current?.proxyProviders.map((item) => [item.name, item]));
  const byId = new Map(current?.proxyProviders.map((item) => [item.id, item]));
  const displayNames = new Map(current?.ruleProviders.map((item) => [item.name, item.displayName]));
  const assigned = new Set<number>();
  const served = new Map<string, Map<number, ReturnType<typeof managedSources>[number]>>();
  const invalidReference = () => new HttpError(409, '这份配置包含无法还原的工作台代理源链接。请在原配置中重新导出，或先在文件中替换为原始上游地址，再导入。');
  return {
    ...document,
    proxyProviders: document.proxyProviders.map((item) => {
      const existing = (intent === 'restore' && item.previousId ? byId.get(item.previousId) : undefined) ?? byName.get(item.name);
      const reference = managedSourceReference(item.config.url);
      let { config, rewriteRules } = item;
      let retainedId: number | undefined;
      if (reference) {
        if (intent !== 'replace' || !db) throw invalidReference();
        let identity: ReturnType<typeof verifySourceCapability>;
        try { identity = verifySourceCapability(db, reference.capability); } catch { throw invalidReference(); }
        if (identity.profileId !== profileId || !byId.has(identity.providerId)) throw invalidReference();
        let sources = served.get(identity.target);
        if (!sources) {
          sources = new Map(managedSources(servedRecord(db, profileId, identity.target)).map(source => [source.id, source]));
          served.set(identity.target, sources);
        }
        const source = sources.get(identity.providerId);
        if (!source) throw invalidReference();
        const { headers: _headers, url: _url, ...options } = config;
        config = { ...options, ...source.upstream };
        rewriteRules = source.rules;
        retainedId = identity.providerId;
      } else {
        if (intent === 'replace' && item.requiresUrl && existing) {
          const { url, headers } = existing.config;
          config = { ...config, ...(url === undefined ? {} : { url }), ...(headers === undefined ? {} : { headers }) };
        }
        // A different upstream imported under a reused name is a different identity.
        if (existing && config.url === existing.config.url && config.path === existing.config.path) {
          retainedId = existing.id;
          if (intent === 'replace') rewriteRules ??= existing.rewriteRules;
        }
      }
      if (retainedId !== undefined && assigned.has(retainedId)) throw invalidReference();
      if (retainedId !== undefined) assigned.add(retainedId);
      return { ...item, config, rewriteRules, retainedId };
    }),
    ruleProviders: document.ruleProviders.map((item) => ({
      ...item,
      displayName: item.displayName ?? displayNames.get(item.name) ?? ''
    }))
  };
}

export function importedSnapshot(profile: Profile, document: PreparedDocument): Snapshot {
  const order = (index: number) => ({ id: index + 1, sortOrder: index + 1 });
  return {
    profile: {
      ...profile, mode: document.mode, logLevel: document.logLevel, ipv6: document.ipv6,
      settings: document.settings, clientOptions: document.clientOptions,
      targetPlatform: document.targetPlatform ?? profile.targetPlatform
    },
    proxies: document.proxies.map((item, index) => ({ ...item, ...order(index) })),
    proxyProviders: document.proxyProviders.map(({ retainedId, ...item }, index) => {
      const sourceType = item.requiresUrl || item.config.url ? 'remote' : 'local';
      return {
        ...item, ...order(index), id: retainedId ?? -(index + 1), sourceType,
        requiresUrl: sourceType === 'remote' && !item.config.url,
        sourceConfigured: Boolean(sourceType === 'remote' ? item.config.url : item.config.path),
        headersConfigured: Boolean(item.config.headers && Object.keys(item.config.headers).length)
      };
    }),
    proxyGroups: document.proxyGroups.map((item, index) => ({ ...item, ...order(index) })),
    ruleProviders: document.ruleProviders.map((item, index) => ({
      ...item, ...order(index), displayName: item.displayName ?? '',
      sourceConfigured: item.providerType === 'inline' ||
        Boolean(item.providerType === 'remote' ? item.config.url : item.config.path),
      headersConfigured: Boolean(item.config.headers && Object.keys(item.config.headers).length),
      entries: item.entries.map((value, i) => ({ value, ...order(i) }))
    })),
    rules: document.rules.map((item, index) => ({ ...item, id: index + 1, priority: index + 1 })),
    hosts: document.hosts.map((item, index) => ({ ...item, ...order(index) })),
    advancedSections: document.advancedSections.map((item, index) => ({ ...item, ...order(index) }))
  };
}

export function importPreviewFingerprint(profile: Profile, document: PreparedDocument) {
  return createHmac('sha256', getEncryptionKey()).update('import-preview:v1:')
    .update(JSON.stringify([profile.id, profile.revision, document])).digest('hex');
}
