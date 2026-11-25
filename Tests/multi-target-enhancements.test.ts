import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { parse, stringify } from 'yaml';

import { GET as overrideDownload } from '../app/api/config_download/[token]/override/[slug]/route';
import { POST as rotateOverrideLinkRoute, DELETE as revokeOverrideLinkRoute } from '../app/api/profiles/[profileId]/overrides/download-link/route';
import { GET as listOverridesRoute, POST as createOverrideRoute } from '../app/api/profiles/[profileId]/overrides/route';
import { PUT as updateOverrideRoute, DELETE as deleteOverrideRoute } from '../app/api/profiles/[profileId]/overrides/[overrideId]/route';
import { resetEncryptionCacheForTests } from '../lib/crypto';
import { closeDbForTests, getDb } from '../lib/db';
import { getDeliveryStatus, getLatestConfig } from '../lib/delivery';
import { managedProxySource, materializeYamlArtifact } from '../lib/managed-proxy-source';
import { getLatestMihomoConfig, getMihomoStatus } from '../lib/mihomo-delivery';
import { compileMihomo } from '../lib/mihomo-export';
import { previewProxySource } from '../lib/proxy-source-preview';
import {
  createProfile,
  createProxy,
  createProxyGroup,
  createProxyProvider,
  deleteProxyGroup,
  getCompilationSnapshot,
  getSnapshot,
  resetRepositoryForTests,
  saveSettings,
  updateProxyGroup
} from '../lib/repository';
import { buildResourceGraph } from '../lib/resource-graph';
import { formatSubscriptionUserinfo, parseSubscriptionUserinfo } from '../lib/upstream-download';
import { validateSnapshot } from '../lib/validation';

const dir = mkdtempSync(join(tmpdir(), 'forge-multi-target-'));
const admin = 'multi-target-admin-fixture';
let serial = 0;

beforeEach(() => {
  closeDbForTests();
  resetRepositoryForTests();
  resetEncryptionCacheForTests();
  process.env.STASH_DB_PATH = join(dir, `${++serial}.sqlite3`);
  process.env.STASH_KEY_PATH = join(dir, `${serial}.key`);
  process.env.STASH_ADMIN_TOKEN = admin;
  process.env.STASH_PUBLIC_BASE_URL = 'https://forge.example.test';
  delete process.env.STASH_SEED_EXAMPLE;
  delete process.env.STASH_SECRET_KEY;
});

after(() => {
  closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

test('per-target clientOptions customize Mihomo & Stash independently while stripping tiles and ssid-policy in Mihomo', () => {
  const { profile } = createProfile('Dual target overrides', stringify({
    ipv6: true,
    tiles: [{ name: 'sample-tile', title: 'Tile', content: 'ok' }],
    dns: {
      'follow-rule': true,
      'fake-ip-range': '198.18.0.1/16',
      nameserver: ['https://8.8.8.8/dns-query'],
      'proxy-server-nameserver': ['223.5.5.5'],
      'nameserver-policy': {
        'geosite:private': 'system',
        'geosite:cn': ['https://dns.alidns.com/dns-query']
      }
    },
    proxies: [{ name: 'NodeA', type: 'socks5', server: '192.0.2.1', port: 1080 }],
    'proxy-groups': [
      { name: 'Select', type: 'select', proxies: ['NodeA', 'DIRECT'], 'ssid-policy': { HomeWiFi: 'DIRECT' } }
    ],
    rules: ['MATCH,Select']
  }));

  // Before adding Mihomo override, compileMihomo strips tiles & ssid-policy with warnings and warns on geosite:private: system
  const initialMihomo = compileMihomo(getCompilationSnapshot(profile.id));
  assert.ok(initialMihomo.artifact);
  assert.ok(initialMihomo.issues.some((i) => i.code === 'mihomo.omitted-sections' && i.message.includes('tiles')));
  assert.ok(initialMihomo.issues.some((i) => i.code === 'mihomo.omitted-group-options' && i.message.includes('Select')));
  assert.ok(initialMihomo.issues.some((i) => i.code === 'mihomo.dns-private-system'));
  const parsedBefore = parse(initialMihomo.artifact.yaml);
  assert.equal(parsedBefore.tiles, undefined);
  assert.equal(parsedBefore['proxy-groups'][0]['ssid-policy'], undefined);

  // Add per-target overrides: Mihomo gets dhcp://en0 + sniffer + direct-nameserver; Stash keeps system and strips direct-nameserver
  const snap = getSnapshot(profile.id);
  saveSettings(profile.id, {
    mode: snap.profile.mode,
    logLevel: snap.profile.logLevel,
    ipv6: true,
    targetPlatform: 'ios',
    settings: snap.profile.settings,
    clientOptions: {
      mihomo: {
        dns: {
          ipv6: false,
          'direct-nameserver': ['https://dns.alidns.com/dns-query'],
          'nameserver-policy': { 'geosite:private': ['dhcp://en0'] }
        },
        sections: {
          sniffer: { enable: true, sniff: { TLS: { ports: [443] } } }
        }
      },
      stash: {
        dns: { ipv6: false }
      }
    }
  });

  const stashYaml = parse(getLatestConfig(profile.id).yaml);
  const mihomoResult = compileMihomo(getCompilationSnapshot(profile.id));
  assert.ok(mihomoResult.artifact);
  assert.equal(mihomoResult.issues.some((i) => i.code === 'mihomo.dns-private-system'), false);
  const mihomoYaml = parse(mihomoResult.artifact.yaml);

  assert.equal(stashYaml.dns['nameserver-policy']['geosite:private'], 'system');
  assert.equal(stashYaml.dns.ipv6, false);
  assert.equal(stashYaml.sniffer, undefined);
  assert.deepEqual(stashYaml['proxy-groups'][0]['ssid-policy'], { HomeWiFi: 'DIRECT' });

  assert.deepEqual(mihomoYaml.dns['nameserver-policy']['geosite:private'], ['dhcp://en0']);
  assert.deepEqual(mihomoYaml.dns['nameserver-policy']['geosite:cn'], ['https://dns.alidns.com/dns-query']);
  assert.deepEqual(mihomoYaml.dns['direct-nameserver'], ['https://dns.alidns.com/dns-query']);
  assert.equal(mihomoYaml.dns.ipv6, false);
  assert.deepEqual(mihomoYaml.sniffer, { enable: true, sniff: { TLS: { ports: [443] } } });

  if (process.env.MIHOMO_TEST_BIN) {
    const work = join(dir, `kernel-${serial}`);
    mkdirSync(work);
    const file = join(work, 'config.yaml');
    writeFileSync(file, mihomoResult.artifact.yaml);
    const kernel = spawnSync(process.env.MIHOMO_TEST_BIN, ['-t', '-d', work, '-f', file], {
      encoding: 'utf8', timeout: 20_000
    });
    assert.ifError(kernel.error);
    assert.equal(kernel.status, 0, kernel.stdout + kernel.stderr);
  }
});

test('target-scoped proxy rewrite rules apply only to selected targets', async () => {
  const { profile } = createProfile('Target scoped rewrites');
  createProxyProvider(profile.id, {
    name: 'Feed',
    config: { type: 'http' },
    sourceUrl: 'https://provider.example.test/sub',
    rewriteRules: [
      { matchName: '', operation: 'set', field: 'block-quic', value: 'off', targets: ['stash'] },
      { matchName: '', operation: 'set', field: 'ip-version', value: 'ipv4-prefer', targets: ['mihomo'] }
    ]
  });

  const req = new Request('https://forge.example.test/api/profiles/1/config_download');
  const stashMat = materializeYamlArtifact(getLatestConfig(profile.id), req, 'stash');
  const mihomoMat = materializeYamlArtifact(getLatestMihomoConfig(profile.id), req, 'mihomo');
  const stashCap = new URL(parse(stashMat.yaml)['proxy-providers'].Feed.url).pathname.split('/')[3];
  const mihomoCap = new URL(parse(mihomoMat.yaml)['proxy-providers'].Feed.url).pathname.split('/')[3];

  const upstream = async () => ({
    text: 'proxies: [{name: Node1, type: ss, server: 192.0.2.1, port: 443, cipher: aes-128-gcm, password: p}]',
    userinfo: { upload: 100, download: 200, total: 1000, expire: 1900000000 }
  });

  const stashRes = await managedProxySource(stashCap, upstream);
  const mihomoRes = await managedProxySource(mihomoCap, upstream);
  const stashNode = parse(stashRes.yaml).proxies[0];
  const mihomoNode = parse(mihomoRes.yaml).proxies[0];

  assert.equal(stashNode['block-quic'], 'off');
  assert.equal(stashNode['ip-version'], undefined);
  assert.equal(mihomoNode['ip-version'], 'ipv4-prefer');
  assert.equal(mihomoNode['block-quic'], undefined);

  // Verify Subscription-Userinfo caching, formatting, and exposure in delivery status
  assert.deepEqual(stashRes.userinfo, { upload: 100, download: 200, total: 1000, expire: 1900000000 });
  assert.equal(formatSubscriptionUserinfo(stashRes.userinfo!), 'upload=100; download=200; total=1000; expire=1900000000');
  assert.deepEqual(parseSubscriptionUserinfo('upload=10; download=20; total=300; expire=1900000000'), {
    upload: 10, download: 20, total: 300, expire: 1900000000
  });
  const delivery = getDeliveryStatus(profile.id);
  assert.deepEqual(delivery.managedSources?.[0].userinfo, { upload: 100, download: 200, total: 1000, expire: 1900000000 });
  const mihomoDelivery = getMihomoStatus(profile.id);
  assert.deepEqual(mihomoDelivery.managedSources?.[0].userinfo, { upload: 100, download: 200, total: 1000, expire: 1900000000 });
});

test('network semantic diagnostics detect overseas direct DNS, fake-ip IPv6, unused resources, and allow classical no-resolve', () => {
  const { profile } = createProfile('Semantic diagnostics', stringify({
    ipv6: true,
    dns: {
      'follow-rule': true,
      'fake-ip-range': '198.18.0.1/16',
      nameserver: ['https://8.8.8.8/dns-query'],
      'proxy-server-nameserver': ['223.5.5.5']
    },
    proxies: [{ name: 'DirectNode', type: 'socks5', server: '192.0.2.1', port: 1080 }],
    'proxy-groups': [
      { name: 'UsedGroup', type: 'select', proxies: ['DirectNode'] },
      { name: 'OrphanGroup', type: 'select', proxies: ['DirectNode'] }
    ],
    'rule-providers': {
      'direct-services': { type: 'inline', behavior: 'domain', payload: ['+.apple.com'] },
      'classical-social': { url: 'https://rules.example.test/social.yaml', behavior: 'classical' },
      'orphan-ads': { type: 'inline', behavior: 'domain', payload: ['+.ads.example.test'] }
    },
    rules: [
      'RULE-SET,direct-services,DIRECT',
      'RULE-SET,classical-social,UsedGroup,no-resolve',
      'MATCH,UsedGroup'
    ]
  }));

  const validation = validateSnapshot(getCompilationSnapshot(profile.id));
  assert.equal(validation.valid, true);
  assert.ok(validation.issues.some((i) => i.code === 'dns.direct-overseas-resolver' && i.severity === 'warning'));
  assert.ok(validation.issues.some((i) => i.code === 'dns.fake-ip-ipv6' && i.severity === 'info'));
  assert.ok(validation.issues.some((i) => i.code === 'rule-provider.unused' && i.message.includes('orphan-ads')));
  assert.ok(validation.issues.some((i) => i.code === 'proxy-group.unused' && i.message.includes('OrphanGroup')));
  // classical RULE-SET with no-resolve must NOT trigger rule.no-resolve-unnecessary
  assert.equal(validation.issues.some((i) => i.code === 'rule.no-resolve-unnecessary'), false);
});

test('proxy source preview analyzes real group regex coverage and uncovered auto-pool nodes', async () => {
  const { profile } = createProfile('Group coverage');
  const provider = createProxyProvider(profile.id, {
    name: 'GLaDOS',
    config: { type: 'http' },
    sourceUrl: 'https://provider.example.test/glados'
  });
  createProxyGroup(profile.id, {
    name: 'US Auto',
    type: 'url-test',
    config: { use: ['GLaDOS'], filter: '^US-', interval: 300, url: 'http://www.gstatic.com/generate_204' }
  });
  createProxyGroup(profile.id, {
    name: 'Empty Match',
    type: 'url-test',
    config: { use: ['GLaDOS'], filter: '^DE-', interval: 300, url: 'http://www.gstatic.com/generate_204' }
  });

  const preview = await previewProxySource(
    profile.id,
    { providerId: provider.id, config: {}, rewriteRules: [] },
    async () => stringify({
      proxies: [
        { name: 'US-01', type: 'ss', server: '192.0.2.1', port: 443, cipher: 'aes-128-gcm', password: 'p' },
        { name: 'US-02', type: 'ss', server: '192.0.2.2', port: 443, cipher: 'aes-128-gcm', password: 'p' },
        { name: 'SG-Express-1', type: 'ss', server: '192.0.2.3', port: 443, cipher: 'aes-128-gcm', password: 'p' }
      ]
    })
  );

  assert.equal(preview.totalNodes, 3);
  assert.ok(preview.groupCoverage);
  const us = preview.groupCoverage.groups.find((g) => g.name === 'US Auto');
  const empty = preview.groupCoverage.groups.find((g) => g.name === 'Empty Match');
  assert.equal(us?.matchedCount, 2);
  assert.equal(empty?.matchedCount, 0);
  assert.equal(preview.groupCoverage.uncoveredAutoCount, 1);
  assert.deepEqual(preview.groupCoverage.uncoveredAutoSamples, ['SG-Express-1']);
});

test('dialer-proxy is validated, protected from deletion, updated on rename, and shown in resource graph', () => {
  const { profile } = createProfile('Dialer linkage');
  const relayGroup = createProxyGroup(profile.id, {
    name: 'FrontHop',
    type: 'select',
    config: { proxies: ['DIRECT'] }
  });
  const landing = createProxy(profile.id, {
    name: 'LandingVPS',
    type: 'socks5',
    config: { server: '192.0.2.9', port: 1080, 'dialer-proxy': 'FrontHop' }
  });

  // Graph includes dialer-proxy edge
  const graph = buildResourceGraph(getSnapshot(profile.id));
  assert.ok(graph.edges.some((e) => e.from === `proxies:${landing.id}` && e.to === `proxy-groups:${relayGroup.id}` && e.label === '链式前置'));

  // Deletion of FrontHop is blocked while referenced by dialer-proxy
  assert.throws(() => deleteProxyGroup(profile.id, relayGroup.id), /dialer-proxy/);

  // Renaming FrontHop propagates to LandingVPS.config['dialer-proxy']
  updateProxyGroup(profile.id, relayGroup.id, { name: 'FrontHopRenamed', type: 'select', config: { proxies: ['DIRECT'] } });
  const updated = getSnapshot(profile.id).proxies.find((p) => p.id === landing.id);
  assert.equal(updated?.config['dialer-proxy'], 'FrontHopRenamed');

  // Missing dialer-proxy triggers validation error
  createProxy(profile.id, {
    name: 'BrokenLanding',
    type: 'socks5',
    config: { server: '192.0.2.10', port: 1080, 'dialer-proxy': 'NonExistentHop' }
  });
  const check = validateSnapshot(getCompilationSnapshot(profile.id));
  assert.equal(check.valid, false);
  assert.ok(check.issues.some((i) => i.code === 'proxy.dialer-missing'));
});

test('Stash overrides CRUD, starter tile bundle, tokenized download with BASE_URL expansion, and backup verify', async () => {
  const { profile } = createProfile('Stash overrides hosting');
  const authHeaders = { 'X-Admin-Token': admin, 'Content-Type': 'application/json' };
  const ctx = { params: Promise.resolve({ profileId: String(profile.id) }) };

  // Unauthenticated access rejected
  assert.equal((await listOverridesRoute(new Request(`https://forge.example.test/api/profiles/${profile.id}/overrides`), ctx)).status, 401);

  // Install starter tile bundle
  const installedRes = await createOverrideRoute(
    new Request(`https://forge.example.test/api/profiles/${profile.id}/overrides`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ preset: 'starter-tiles' })
    }),
    ctx
  );
  assert.equal(installedRes.status, 201);
  const installedBody = await installedRes.json();
  assert.equal(installedBody.installed, 3);
  assert.equal(installedBody.items.length, 3);

  // Rotate token and fetch .stoverride & .js via read-only device route
  const tokenRes = await rotateOverrideLinkRoute(
    new Request(`https://forge.example.test/api/profiles/${profile.id}/overrides/download-link`, {
      method: 'POST', headers: authHeaders
    }),
    ctx
  );
  assert.equal(tokenRes.status, 200);
  const { basePath } = await tokenRes.json();
  assert.match(basePath, /^\/api\/config_download\/[A-Za-z0-9_-]{43}\/override$/);
  const token = basePath.split('/')[3];

  const ovRes = await overrideDownload(
    new Request(`https://forge.example.test/api/config_download/${token}/override/stash-tiles.stoverride`),
    { params: Promise.resolve({ token, slug: 'stash-tiles.stoverride' }) }
  );
  assert.equal(ovRes.status, 200);
  assert.equal(ovRes.headers.get('Cache-Control'), 'no-store');
  const ovText = await ovRes.text();
  assert.doesNotMatch(ovText, /\{\{BASE_URL\}\}/);
  assert.match(ovText, new RegExp(`https://forge\\.example\\.test/api/config_download/${token}/override/ai-media-check\\.js`));
  const parsedOv = parse(ovText);
  assert.ok(Array.isArray(parsedOv.tiles) && parsedOv.tiles.length >= 4);

  const jsRes = await overrideDownload(
    new Request(`https://forge.example.test/api/config_download/${token}/override/ai-media-check.js`),
    { params: Promise.resolve({ token, slug: 'ai-media-check.js' }) }
  );
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('Content-Type')!, /javascript/);

  // Update to disabled -> 404 on device download
  const ovItem = installedBody.items.find((i: { slug: string }) => i.slug === 'stash-tiles.stoverride');
  const disableRes = await updateOverrideRoute(
    new Request(`https://forge.example.test/api/profiles/${profile.id}/overrides/${ovItem.id}`, {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ ...ovItem, enabled: false })
    }),
    { params: Promise.resolve({ profileId: String(profile.id), overrideId: String(ovItem.id) }) }
  );
  assert.equal(disableRes.status, 200);
  assert.equal(
    (await overrideDownload(
      new Request(`https://forge.example.test/api/override_download/${token}/stash-tiles.stoverride`),
      { params: Promise.resolve({ token, slug: 'stash-tiles.stoverride' }) }
    )).status,
    404
  );

  // Backup create & verify covers v10 encrypted stash_overrides and stash_override_links
  const backupDir = join(dir, `v10-backup-${serial}`);
  const backupRun = spawnSync(process.execPath, ['Scripts/manage-backup.mjs', 'create', backupDir], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8'
  });
  assert.equal(backupRun.status, 0, backupRun.stderr);
  assert.equal(JSON.parse(backupRun.stdout).schemaVersion, 10);

  // Delete override item & revoke token
  assert.equal(
    (await deleteOverrideRoute(
      new Request(`https://forge.example.test/api/profiles/${profile.id}/overrides/${ovItem.id}`, {
        method: 'DELETE', headers: authHeaders
      }),
      { params: Promise.resolve({ profileId: String(profile.id), overrideId: String(ovItem.id) }) }
    )).status,
    204
  );
  assert.equal(
    (await revokeOverrideLinkRoute(
      new Request(`https://forge.example.test/api/profiles/${profile.id}/overrides/download-link`, {
        method: 'DELETE', headers: authHeaders
      }),
      ctx
    )).status,
    204
  );
  assert.equal(
    (await overrideDownload(
      new Request(`https://forge.example.test/api/override_download/${token}/ai-media-check.js`),
      { params: Promise.resolve({ token, slug: 'ai-media-check.js' }) }
    )).status,
    404
  );
});
