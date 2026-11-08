import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../../lib/types';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const testToken = ['browser', 'test', 'admin'].join('-');
const headers = { 'X-Admin-Token': testToken };
let sequence = 0;
const name = (label: string) => `${label}-${Date.now()}-${++sequence}`;

async function create(request: APIRequestContext, label: string, yaml?: string): Promise<Snapshot> {
  const response = await request.post('/api/profiles', {
    headers,
    data: { name: name(label), ...(yaml ? { importYaml: yaml } : {}) }
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function snapshot(request: APIRequestContext, profileId: number): Promise<Snapshot> {
  const response = await request.get(`/api/profiles/${profileId}/snapshot`, { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function login(page: Page, profile?: Snapshot) {
  if (profile) {
    await page.addInitScript((id) => sessionStorage.setItem('stash-profile-id', String(id)), profile.profile.id);
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进入配置控制台' })).toBeVisible();
  await page.getByLabel('管理员令牌').fill(testToken);
  await page.getByRole('button', { name: '验证并连接' }).click();
  if (profile) await expect(page.getByRole('heading', { name: profile.profile.name, exact: true })).toBeVisible();
  else await expect(page.getByRole('heading', { name: '进入配置控制台' })).toBeHidden();
}

async function navigate(page: Page, section: string) {
  await page.locator('.side-nav').getByRole('button', { name: section, exact: true }).click();
}

async function dismissDiscard(page: Page) {
  const dialog = page.getByRole('dialog', { name: '放弃未保存的修改？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
}

async function acceptDiscard(page: Page) {
  const dialog = page.getByRole('dialog', { name: '放弃未保存的修改？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
}

test('initial connection failure is recoverable and management requires login', async ({ page, request }) => {
  let fail = true;
  await page.route('**/api/meta', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'temporary-test-outage' }) });
    } else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: '无法更新配置' })).toBeVisible();
  await page.getByRole('button', { name: '重新连接' }).click();
  await expect(page.getByRole('heading', { name: '进入配置控制台' })).toBeVisible();
  expect((await request.get('/api/profiles')).status()).toBe(401);
  await page.getByLabel('管理员令牌').fill('invalid-browser-test-token');
  await page.getByRole('button', { name: '验证并连接' }).click();
  await expect(page.getByRole('button', { name: '验证并连接' })).toBeEnabled();
  await expect(page.locator('.auth-error')).toContainText('管理员令牌无效');
  await page.getByLabel('管理员令牌').fill(testToken);
  await page.getByRole('button', { name: '验证并连接' }).click();
  await expect(page.locator('.overview-hero')).toBeVisible();
});

test('new YAML profiles validate before creation and valid imports open their resource relationships', async ({ page, request }) => {
  const initial = await create(request, 'creation-start');
  await login(page, initial);
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建配置' });
  const profileName = name('created-in-browser');
  await dialog.getByLabel('配置名称').fill(profileName);
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: '导入已有配置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '创建配置', exact: true })).toBeDisabled();
  await dialog.getByLabel('完整配置').fill('proxies: invalid\nrules: ["MATCH,DIRECT"]');
  await expect(dialog.getByRole('alert')).toContainText(/proxies/);
  await expect(dialog.getByRole('button', { name: '创建配置', exact: true })).toBeDisabled();
  await expect(dialog).toBeVisible();
  const profiles = await (await request.get('/api/profiles', { headers })).json();
  expect(profiles.items.some((item: { name: string }) => item.name === profileName)).toBeFalsy();
  await dialog.getByLabel('完整配置').fill('hosts:\n  browser-created.test: 192.0.2.9\nrules: ["MATCH,DIRECT"]\n');
  await dialog.getByRole('button', { name: '创建配置', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.side-nav button.active')).toHaveText('关联关系');
  await navigate(page, '总览');
  await expect(page.getByRole('heading', { name: profileName, exact: true })).toBeVisible();
});

test('a malformed replacement import preserves the complete current profile and can be corrected', async ({ page, request }) => {
  const initial = await create(request, 'replace-import', 'hosts:\n  original.test: 192.0.2.1\nrules: ["MATCH,DIRECT"]');
  await login(page, initial);
  await page.getByRole('button', { name: '导入配置文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入并替换当前 Profile' });
  await dialog.getByRole('textbox').fill('rules: {invalid: true}');
  await expect(dialog.getByRole('button', { name: '导入完整配置', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/rules/);
  await expect(dialog.getByRole('button', { name: '导入完整配置', exact: true })).toBeDisabled();
  await expect(dialog).toBeVisible();
  const unchanged = await snapshot(request, initial.profile.id);
  expect(unchanged.profile.revision).toBe(initial.profile.revision);
  expect(unchanged.hosts).toEqual(initial.hosts);
  await dialog.getByRole('textbox').fill('hosts:\n  replacement.test: 192.0.2.2\nrules: ["MATCH,DIRECT"]');
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(dialog.locator('.config-diff')).toContainText('original.test');
  await expect(dialog.locator('.config-diff')).toContainText('replacement.test');
  await expect(dialog.getByText(/注释、原始排版和锚点写法不会保留/)).toBeVisible();
  await dialog.getByRole('button', { name: '导入完整配置', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await snapshot(request, initial.profile.id)).hosts[0]?.pattern).toBe('replacement.test');
});

test('unsaved settings and resource dialogs protect cancel, navigation and refresh', async ({ page, request }) => {
  const initial = await create(request, 'dirty-guards');
  await login(page, initial);
  await navigate(page, '全局与 DNS');
  const originalDns = await page.getByRole('textbox', { name: 'nameserver', exact: true }).inputValue();
  await page.getByRole('textbox', { name: 'nameserver', exact: true }).fill('https://dns.example.test/dns-query');
  await navigate(page, '路由规则');
  await dismissDiscard(page);
  await expect(page.getByRole('heading', { name: '全局设置与 DNS', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'nameserver', exact: true })).toHaveValue('https://dns.example.test/dns-query');
  await page.getByRole('button', { name: '刷新快照', exact: true }).click();
  await dismissDiscard(page);
  await expect(page.getByRole('textbox', { name: 'nameserver', exact: true })).toHaveValue('https://dns.example.test/dns-query');
  await page.getByRole('button', { name: '刷新快照', exact: true }).click();
  await acceptDiscard(page);
  await expect(page.getByRole('textbox', { name: 'nameserver', exact: true })).toHaveValue(originalDns);
  await navigate(page, 'Hosts');
  await page.getByRole('button', { name: /新增/ }).click();
  const editor = page.getByRole('dialog', { name: '新增Host 映射' });
  await editor.getByLabel('Hostname / Wildcard').fill('unsaved.test');
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await dismissDiscard(page);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Hostname / Wildcard')).toHaveValue('unsaved.test');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await acceptDiscard(page);
  await expect(editor).toBeHidden();
  expect((await snapshot(request, initial.profile.id)).hosts).toHaveLength(0);
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const creation = page.getByRole('dialog', { name: '新建配置', exact: true });
  await creation.getByLabel('配置名称').fill('unsaved-profile');
  await creation.getByRole('button', { name: '关闭', exact: true }).click();
  await dismissDiscard(page);
  await expect(creation.getByLabel('配置名称')).toHaveValue('unsaved-profile');
  await creation.getByRole('button', { name: '取消', exact: true }).click();
  await acceptDiscard(page);
  await expect(creation).toBeHidden();
  await page.getByRole('button', { name: '导入配置文件', exact: true }).click();
  const replacement = page.getByRole('dialog', { name: '导入并替换当前 Profile' });
  await replacement.getByRole('textbox').fill('rules: ["MATCH,DIRECT"]');
  await replacement.getByRole('button', { name: '关闭', exact: true }).click();
  await dismissDiscard(page);
  await expect(replacement.getByRole('textbox')).toHaveValue('rules: ["MATCH,DIRECT"]');
  await replacement.getByRole('button', { name: '取消', exact: true }).click();
  await acceptDiscard(page);
  await expect(replacement).toBeHidden();
});

test('navigation stays blocked while a settings write is in flight', async ({ page, request }) => {
  const initial = await create(request, 'saving-guard');
  await login(page, initial);
  await navigate(page, '全局与 DNS');
  await page.getByRole('textbox', { name: 'nameserver', exact: true }).fill('https://saving.example.test/dns-query');
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/profiles/${initial.profile.id}/settings`, async (route) => {
    intercepted();
    await pending;
    await route.continue();
  });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await started;
  await navigate(page, '路由规则');
  await expect(page.locator('.toast-bad')).toContainText('正在保存');
  await expect(page.getByRole('heading', { name: '全局设置与 DNS', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await expect.poll(async () => (await snapshot(request, initial.profile.id)).profile.settings.dns).toMatchObject({
    nameserver: ['https://saving.example.test/dns-query']
  });
  await navigate(page, '路由规则');
  await expect(page.getByRole('heading', { name: '路由规则', exact: true })).toBeVisible();
});

test('invalid drafts preserve device downloads, repair updates them, and link rotation, revocation and history work', async ({ page, request }) => {
  const initial = await create(request, 'delivery-flow');
  const profileId = initial.profile.id;
  await login(page, initial);
  await navigate(page, '下载配置');
  await page.getByRole('button', { name: '生成固定订阅链接', exact: true }).click();
  const linkField = page.getByRole('textbox', { name: '固定配置订阅链接' });
  await expect(linkField).toBeVisible();
  const oldLink = await linkField.inputValue();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 YAML', exact: true }).click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toMatch(/\.yaml$/);
  expect(readFileSync((await downloaded.path())!, 'utf8')).toContain('MATCH,DIRECT');
  const oldConfig = await request.get(oldLink);
  expect(oldConfig.status()).toBe(200);
  const previousRevision = oldConfig.headers()['x-config-revision'];
  const invalidSource = await request.post(`/api/profiles/${profileId}/proxy-providers`, {
    headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` }, data: { name: 'browser-source', sourceType: 'remote', config: { interval: 3600 } }
  });
  expect(invalidSource.status()).toBe(201);
  await page.getByRole('button', { name: '刷新快照', exact: true }).click();
  await expect(page.getByText(/最新修改.*尚未通过检查/)).toBeVisible();
  const stale = await request.get(oldLink);
  expect(stale.headers()['x-config-revision']).toBe(previousRevision);
  await page.getByRole('button', { name: '定位并处理', exact: true }).first().click();
  const editor = page.getByRole('dialog', { name: '编辑代理源' });
  await editor.getByLabel('私人订阅地址（HTTP/HTTPS）').fill('https://subscription.example.test/browser-fixture');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => (await request.get(oldLink)).headers()['x-config-revision']).not.toBe(previousRevision);
  const repaired = await request.get(oldLink);
  expect(await repaired.text()).toContain('https://subscription.example.test/browser-fixture');
  await page.getByRole('button', { name: '更换链接', exact: true }).click();
  await page.getByRole('dialog', { name: '更换固定订阅链接？' }).getByRole('button', { name: '更换', exact: true }).click();
  await expect(linkField).not.toHaveValue(oldLink);
  const newLink = await linkField.inputValue();
  expect((await request.get(oldLink)).status()).toBe(404);
  expect((await request.get(newLink)).status()).toBe(200);
  await page.getByRole('button', { name: '撤销链接', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销固定订阅链接？' }).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(linkField).toBeHidden();
  expect((await request.get(newLink)).status()).toBe(404);
  await navigate(page, '版本');
  await expect(page.locator('.timeline-item')).toHaveCount(3);
  await page.locator('.timeline-item').last().getByRole('button', { name: '查看变化', exact: true }).click();
  const restorePreview = page.getByRole('dialog', { name: /恢复版本 .* 前的变化/ });
  await expect(restorePreview.locator('.config-diff')).toContainText('browser-source');
  await restorePreview.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(restorePreview).toBeHidden();
  await expect.poll(async () => (await snapshot(request, profileId)).proxyProviders.length).toBe(0);
  expect((await request.get(`/api/profiles/${profileId}/config_download`, { headers })).status()).toBe(200);
});

test('profile switching never commits a delayed response over a newer selection', async ({ page, request }) => {
  const initial = await create(request, 'switch-initial');
  const slow = await create(request, 'switch-slow');
  const last = await create(request, 'switch-last');
  await login(page, initial);
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/profiles/${slow.profile.id}/snapshot`, async (route) => {
    const response = await route.fetch();
    intercepted();
    await pending;
    await route.fulfill({ response });
  });
  const picker = page.locator('.profile-picker').getByRole('combobox');
  const slowResponse = page.waitForResponse((response) => response.url().endsWith(`/api/profiles/${slow.profile.id}/snapshot`));
  await picker.click();
  await page.getByRole('option', { name: slow.profile.name, exact: true }).click();
  await started;
  if (await picker.isDisabled()) {
    release();
    await expect(page.getByRole('heading', { name: slow.profile.name, exact: true })).toBeVisible();
    await expect(picker).toBeEnabled();
  }
  await picker.click();
  await page.getByRole('option', { name: last.profile.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: last.profile.name, exact: true })).toBeVisible();
  release();
  await (await slowResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(picker).toContainText(last.profile.name);
  await expect(page.getByRole('heading', { name: last.profile.name, exact: true })).toBeVisible();
});

test('a failed delivery status request can be retried without leaving the download page', async ({ page, request }) => {
  const initial = await create(request, 'delivery-retry');
  await login(page, initial);
  let fail = true;
  await page.route(`**/api/profiles/${initial.profile.id}/delivery`, async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'delivery-status-temporarily-unavailable' }) });
    } else await route.continue();
  });
  await navigate(page, '下载配置');
  await expect(page.locator('.export-panel').getByRole('alert')).toContainText('delivery-status-temporarily-unavailable');
  await expect(page.getByRole('button', { name: '下载 YAML', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重试读取下载状态', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载 YAML', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '重试读取下载状态', exact: true })).toBeHidden();
});

test('rotating a subscription hides the old link and uses the POST result without another status request', async ({ page, request }) => {
  const initial = await create(request, 'rotation-response');
  await login(page, initial);
  await navigate(page, '下载配置');
  await page.getByRole('button', { name: '生成固定订阅链接', exact: true }).click();
  const link = page.getByRole('textbox', { name: '固定配置订阅链接' });
  await expect(link).toBeVisible();
  const previous = await link.inputValue();
  let statusReads = 0;
  await page.route(`**/api/profiles/${initial.profile.id}/delivery`, async (route) => {
    statusReads++;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'unexpected-status-read-after-rotation' }) });
  });
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/profiles/${initial.profile.id}/download-link`, async (route) => {
    const response = await route.fetch();
    intercepted();
    await pending;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '更换链接', exact: true }).click();
  await page.getByRole('dialog', { name: '更换固定订阅链接？' }).getByRole('button', { name: '更换', exact: true }).click();
  await started;
  await expect(link).toBeHidden();
  release();
  await expect(link).toBeVisible();
  await expect(link).not.toHaveValue(previous);
  expect(statusReads).toBe(0);
  expect((await request.get(previous)).status()).toBe(404);
  expect((await request.get(await link.inputValue())).status()).toBe(200);
  await expect(page.locator('.export-panel').getByRole('alert')).toBeHidden();
});

test('an imported rule draft without MATCH can be located, repaired and published', async ({ page, request }) => {
  const initial = await create(request, 'missing-match', 'mode: rule\nrules: []\n');
  const profileId = initial.profile.id;
  await login(page, initial);
  await expect(page.getByRole('button', { name: '处理首个错误', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '处理首个错误', exact: true }).click();
  await expect(page.locator('.side-nav button.active')).toHaveText('路由规则');
  await page.getByRole('button', { name: '新增规则', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新增路由规则' });
  await editor.getByRole('combobox', { name: '规则类型', exact: true }).click();
  await page.getByRole('option', { name: 'MATCH', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: '策略 / 目标组', exact: true })).toContainText('DIRECT');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => {
    const response = await request.get(`/api/profiles/${profileId}/delivery`, { headers });
    return (await response.json()).current;
  }).toBe(true);
  const repaired = await snapshot(request, profileId);
  expect(repaired.rules).toHaveLength(1);
  expect(repaired.rules[0]).toMatchObject({ type: 'MATCH', policy: 'DIRECT', priority: 1 });
  const downloaded = await request.get(`/api/profiles/${profileId}/config_download`, { headers });
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toContain('MATCH,DIRECT');
});

test('viewing relationships cannot bypass the navigation guard during a rule mutation', async ({ page, request }) => {
  const initial = await create(request, 'rule-mutation-navigation', 'rules:\n  - DOMAIN,busy-route.test,DIRECT\n  - MATCH,DIRECT\n');
  const rule = initial.rules.find((item) => item.type === 'DOMAIN')!;
  await login(page, initial);
  await navigate(page, '路由规则');
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { intercepted = resolve; });
  await page.route(`**/api/profiles/${initial.profile.id}/rules/${rule.id}`, async (route) => {
    intercepted();
    await pending;
    await route.continue();
  });
  const card = page.locator('.rule-card').filter({ hasText: 'busy-route.test' });
  await card.getByRole('switch').click();
  await started;
  await card.getByRole('button', { name: '查看关联', exact: true }).click();
  await expect(page.locator('.toast-bad')).toContainText('正在保存');
  await expect(page.locator('.side-nav button.active')).toHaveText('路由规则');
  release();
  await expect(card.getByRole('switch')).toBeEnabled();
  await expect.poll(async () => (await snapshot(request, initial.profile.id)).rules.find((item) => item.id === rule.id)?.enabled).toBe(false);
  await card.getByRole('button', { name: '查看关联', exact: true }).click();
  await expect(page.locator('.side-nav button.active')).toHaveText('关联关系');
});

test('Shadowrocket downloads and updates independently from Stash', async ({ page, request }) => {
  const initial = await create(request, 'shadowrocket', readFileSync('examples/DualClient.yaml', 'utf8'));
  const profileApi = `/api/profiles/${initial.profile.id}`;
  const deliveryStatus = await (await request.get(`${profileApi}/delivery`, { headers })).json();
  expect(deliveryStatus.targets.stash.compiledRevision).toBe(deliveryStatus.compiledRevision);
  expect(deliveryStatus.targets.shadowrocket).toEqual(deliveryStatus.shadowrocket);
  const stale = await request.post(`${profileApi}/download-link`, { headers });
  expect(stale.status()).toBe(200);
  const stashLink: string = (await stale.json()).subscriptionUrl;
  expect((await request.get(`${profileApi}/shadowrocket/config_download`)).status()).toBe(401);

  await login(page, initial);
  await navigate(page, '下载配置');
  await page.getByRole('button', { name: 'Shadowrocket', exact: true }).click();
  await expect(page.getByText('Shadowrocket 兼容性检查', { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .conf', exact: true }).click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toMatch(/\.conf$/);

  await page.getByRole('button', { name: '生成固定订阅链接', exact: true }).click();
  const field = page.getByRole('textbox', { name: '固定配置订阅链接' });
  await expect(field).toHaveValue(/\/config\.conf$/);
  const confLink = await field.inputValue();
  const conf = await request.get(confLink);
  expect(conf.status()).toBe(200);
  expect(conf.headers()['cache-control']).toBe('no-store');
  expect(await conf.text()).toBe(readFileSync((await downloaded.path())!, 'utf8'));
  expect(await conf.text()).toContain('DOMAIN,allow.ads.example,DIRECT\nDOMAIN,blocked.example,REJECT\nDOMAIN-SUFFIX,ads.example,REJECT');
  expect((await request.get(stashLink.replace('config.yaml', 'config.conf'))).status()).toBe(404);
  expect((await request.get(confLink.replace('config.conf', 'config.yaml'))).status()).toBe(404);
  expect((await request.get(confLink + '?url=ignored')).status()).toBe(400);

  const revisionHeaders = async () => ({ ...headers, 'If-Match': `"${(await snapshot(request, initial.profile.id)).profile.revision}"` });
  const incompatible = await request.post(`${profileApi}/rules`, {
    headers: await revisionHeaders(), data: { type: 'GEOSITE', payload: 'CN', policy: 'DIRECT' }
  });
  expect(incompatible.status()).toBe(201);
  await page.getByRole('button', { name: '刷新快照', exact: true }).click();
  await expect(page.getByText('GEOSITE 依赖客户端使用的域名数据版本及匹配类型。请用已核对内容的规则集替代。')).toBeVisible();
  const latestStash = await request.get(stashLink);
  expect(await latestStash.text()).toContain('GEOSITE,CN,DIRECT');
  expect(await (await request.get(confLink)).text()).toBe(await conf.text());

  const newRule = (await snapshot(request, initial.profile.id)).rules.find((rule) => rule.type === 'GEOSITE')!;
  const repaired = await request.put(`${profileApi}/rules/${newRule.id}`, {
    headers: await revisionHeaders(), data: { type: 'DOMAIN', payload: 'new.example', policy: 'REJECT' }
  });
  expect(repaired.status()).toBe(200);
  expect(await (await request.get(confLink)).text()).toContain('DOMAIN,new.example,REJECT');

  await page.getByRole('button', { name: '更换链接', exact: true }).click();
  await page.getByRole('dialog', { name: '更换固定订阅链接？' }).getByRole('button', { name: '更换', exact: true }).click();
  await expect(field).not.toHaveValue(confLink);
  const rotatedLink = await field.inputValue();
  expect((await request.get(confLink)).status()).toBe(404);
  expect((await request.get(rotatedLink)).status()).toBe(200);
  await page.getByRole('button', { name: '撤销链接', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销固定订阅链接？' }).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(field).toBeHidden();
  expect((await request.get(rotatedLink)).status()).toBe(404);
  await page.getByRole('button', { name: 'Stash', exact: true }).click();
  await expect(field).toHaveValue(stashLink);
  expect((await request.get(stashLink)).status()).toBe(200);
});

test('Shadowrocket offers first download for remote rules and explains blocked upstream requests', async ({ page, request }) => {
  const initial = await create(request, 'shadowrocket-source-block', [
    'rule-providers:',
    '  local-only:',
    '    behavior: classical',
    '    format: text',
    '    url: http://127.0.0.1:3117/api/meta',
    'rules: ["RULE-SET,local-only,REJECT", "MATCH,DIRECT"]'
  ].join('\n'));
  await login(page, initial);
  await navigate(page, '下载配置');
  await page.getByRole('button', { name: 'Shadowrocket', exact: true }).click();
  await expect(page.getByText('等待拉取远程来源')).toBeVisible();
  await expect(page.getByRole('button', { name: '预览导出配置', exact: true })).toBeDisabled();
  const root = `/api/profiles/${initial.profile.id}/delivery`;
  expect((await request.get(root + '/shadowrocket/preview', { headers })).status()).toBe(409);
  expect((await (await request.get(root, { headers })).json()).targets.shadowrocket.remoteCheckedAt).toBeNull();
  await page.getByRole('button', { name: '下载 .conf', exact: true }).click();
  await expect(page.getByText('远程来源检查未通过')).toBeVisible();
  await expect(page.getByText('远程来源解析到非公网地址，已阻止下载。', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '固定配置订阅链接' })).toBeHidden();
  await page.getByRole('button', { name: 'Stash', exact: true }).click();
  await expect(page.getByRole('button', { name: '下载 YAML', exact: true })).toBeEnabled();
});

test('Shadowrocket file import previews common and native fields before offering the native download', async ({ page, request }) => {
  const initial = await create(request, 'shadowrocket-import-start');
  await login(page, initial);
  await page.getByRole('button', { name: '导入配置文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入并替换当前 Profile' });
  await dialog.getByRole('textbox').fill(readFileSync('examples/Shadowrocket.conf', 'utf8'));
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  const classification = dialog.getByLabel('字段分类');
  await expect(classification).toContainText('Shadowrocket .conf');
  await expect(classification).toContainText('通用配置');
  await expect(classification).toContainText('原生 RULE-SET / DOMAIN-SET 引用');
  await dialog.getByRole('button', { name: '导入完整配置', exact: true }).click();
  await expect(dialog).toBeHidden();
  await navigate(page, '下载配置');
  await page.getByRole('button', { name: 'Shadowrocket', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .conf', exact: true }).click();
  const download = await downloadEvent;
  const conf = readFileSync((await download.path())!, 'utf8');
  expect(conf).toContain('policy-select-name=Example node');
  expect(conf).toContain('DOMAIN-SET,https://example.org/domains.list,REJECT');
});

test('edits remote proxy rewrites, previews the draft, and downloads a managed Stash provider', async ({ page, request }) => {
  const initial = await create(request, 'rewrite-browser', [
    'proxy-providers:',
    '  fixture-source:',
    '    type: http',
    '    url: https://subscription.example.test/private-rewrite-fixture',
    'rules: ["MATCH,DIRECT"]'
  ].join('\n'));
  const { id } = initial.profile;
  await login(page, initial);
  await navigate(page, '代理源');
  await page.getByRole('button', { name: '编辑 fixture-source', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑代理源' });
  await editor.getByText('节点改写 · Stash', { exact: true }).click();
  await editor.getByRole('button', { name: '添加改写规则', exact: true }).click();
  await editor.getByLabel('节点名称正则').fill('^HK-');
  await editor.getByLabel('协议类型（可选）').fill('ss');
  await editor.getByRole('button', { name: '添加改写规则', exact: true }).click();
  const custom = editor.getByRole('group', { name: '改写规则 2' });
  await custom.getByRole('combobox').filter({ hasText: 'udp' }).click();
  await page.getByRole('option', { name: '自定义字段', exact: true }).click();
  await expect(editor.getByRole('button', { name: '预览改写结果', exact: true })).toBeDisabled();
  await custom.getByLabel('自定义字段名').fill('port');
  await custom.getByRole('combobox').filter({ hasText: '布尔值' }).click();
  await page.getByRole('option', { name: '数字', exact: true }).click();
  await custom.getByRole('spinbutton', { name: '字段值' }).fill('8443');
  const previewPath = `/api/profiles/${id}/proxy-source-preview`;
  await page.route('**' + previewPath, async (route) => {
    const draft = route.request().postDataJSON();
    expect(draft.providerId).toBe(initial.proxyProviders[0].id);
    expect(draft.sourceUrl).toBeUndefined();
    expect(draft.rewriteRules).toEqual([
      { matchName: '^HK-', protocol: 'ss', operation: 'fill', field: 'udp', value: true },
      { matchName: '', operation: 'fill', field: 'port', value: 8443 }
    ]);
    await route.fulfill({ json: { totalNodes: 3, matchedNodes: 2, changedNodes: 1, examples: [{ node: 1, field: 'port', before: 'other', after: 8443 }] } });
  });
  await editor.getByRole('button', { name: '预览改写结果', exact: true }).click();
  await expect(editor.getByText('共 3 个节点，匹配 2 个，实际改写 1 个。')).toBeVisible();
  await expect(editor.getByText('节点 #1 · port：原值已隐藏 → 8443')).toBeVisible();
  expect((await snapshot(request, id)).profile.revision).toBe(initial.profile.revision);
  await editor.getByRole('group', { name: '改写规则 1' }).getByLabel('节点名称正则').fill('^HK-1');
  await expect(editor.getByText('共 3 个节点，匹配 2 个，实际改写 1 个。')).toBeHidden();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
  const saved = (await snapshot(request, id)).proxyProviders[0].rewriteRules!;
  expect(saved[0].matchName).toBe('^HK-1');
  expect(saved[1]).toEqual({ matchName: '', operation: 'fill', field: 'port', value: 8443 });

  await navigate(page, '下载配置');
  await expect(page.getByText(/这份配置中的改写代理源由工作台提供/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 YAML', exact: true }).click();
  const content = readFileSync((await (await download).path())!, 'utf8');
  expect(content).toMatch(/\/api\/proxy-source\/m1\.\d+\.\d+\.[a-f0-9]{64}\/proxies.yaml/);
  expect(content).not.toContain('private-rewrite-fixture');
  await expect(page.getByLabel('固定配置订阅链接')).toBeHidden();
});

test('managed YAML import, history restore and independent link revocation preserve device access boundaries', async ({ page, request }) => {
  const initial = await create(request, 'managed-lifecycle-browser');
  const root = `/api/profiles/${initial.profile.id}`;
  const add = await request.post(root + '/proxy-providers', {
    headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` },
    data: {
      name: 'managed-fixture', sourceUrl: 'http://127.0.0.1:3117/api/meta', config: { type: 'http' },
      rewriteRules: [{ matchName: 'fixture', field: 'udp', operation: 'fill', value: true }]
    }
  });
  expect(add.status()).toBe(201);
  const before = await snapshot(request, initial.profile.id);
  await login(page, before);
  await navigate(page, '下载配置');
  async function download() {
    const event = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 YAML', exact: true }).click();
    return readFileSync((await (await event).path())!, 'utf8');
  }
  const original = await download();
  const sourceUrl = (text: string) => parse(text)['proxy-providers']['managed-fixture'].url as string;
  const oldSource = sourceUrl(original);
  // The isolated fixture points at loopback, which upstream access rejects.
  // 502 means the signed link still resolves; a revoked or detached link is 404.
  expect((await request.get(oldSource)).status()).toBe(502);
  await expect(page.getByRole('textbox', { name: '固定配置订阅链接' })).toBeHidden();
  await page.getByRole('button', { name: '生成固定订阅链接', exact: true }).click();
  const field = page.getByRole('textbox', { name: '固定配置订阅链接' });
  await expect(field).toBeVisible();
  const subscription = await field.inputValue();
  await page.getByRole('button', { name: '撤销链接', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销固定订阅链接？' }).getByRole('button', { name: '撤销', exact: true }).click();
  await expect(field).toBeHidden();
  expect((await request.get(subscription)).status()).toBe(404);
  expect(sourceUrl(await download())).toBe(oldSource);
  expect((await (await request.get(root + '/delivery', { headers })).json()).targets.stash.subscriptionPath).toBeNull();

  await page.getByRole('button', { name: '导入配置文件', exact: true }).click();
  const replace = page.getByRole('dialog', { name: '导入并替换当前 Profile' });
  await replace.getByRole('textbox').fill(original);
  await replace.getByRole('button', { name: '导入为新配置', exact: true }).click();
  const clone = page.getByRole('dialog', { name: '新建配置' });
  await clone.getByLabel('配置名称').fill(name('blocked-clone'));
  await expect(clone.getByRole('alert')).toContainText('无法还原的工作台代理源链接');
  await expect(clone.getByRole('button', { name: '创建配置', exact: true })).toBeDisabled();
  await clone.getByRole('button', { name: '改为替换当前配置', exact: true }).click();
  await replace.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(replace.getByLabel('导入后的客户端检查')).toContainText('远程来源待检查');
  await replace.getByRole('button', { name: '导入完整配置', exact: true }).click();
  await expect(replace).toBeHidden();
  expect((await snapshot(request, initial.profile.id)).proxyProviders[0].id).toBe(before.proxyProviders[0].id);
  await navigate(page, '版本');
  await page.locator('.timeline-item').filter({ hasText: `REV ${String(before.profile.revision).padStart(3, '0')}` })
    .getByRole('button', { name: '查看变化', exact: true }).click();
  await page.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认恢复', exact: true })).toBeHidden();
  expect((await request.get(oldSource)).status()).toBe(502);
  await navigate(page, '下载配置');
  await page.getByRole('button', { name: '更换代理源链接', exact: true }).click();
  await page.getByRole('button', { name: '确认更换', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '更换代理源链接？' })).toBeHidden();
  expect((await request.get(oldSource)).status()).toBe(404);
  const replacement = sourceUrl(await download());
  expect(replacement).not.toBe(oldSource);
  expect((await request.get(replacement)).status()).toBe(502);
  await page.getByRole('button', { name: '撤销代理源链接', exact: true }).click();
  await page.getByRole('button', { name: '确认撤销', exact: true }).click();
  await expect(page.getByText('链接已撤销', { exact: false }).last()).toBeVisible();
  expect((await request.get(replacement)).status()).toBe(404);
  const whileRevoked = sourceUrl(await download());
  expect((await request.get(whileRevoked)).status()).toBe(404);
  await page.getByRole('button', { name: '重新启用代理源链接', exact: true }).click();
  await page.getByRole('button', { name: '确认启用', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '重新启用代理源链接？' })).toBeHidden();
  expect((await request.get(whileRevoked)).status()).toBe(404);
  expect((await request.get(sourceUrl(await download()))).status()).toBe(502);
});

test('manual Stash publication and rollback leave Shadowrocket and the saved draft independent', async ({ page, request }) => {
  const initial = await create(request, 'independent-publication');
  const root = `/api/profiles/${initial.profile.id}`;
  const stashLink: string = (await (await request.post(root + '/download-link', { headers })).json()).subscriptionUrl;
  const shadowLink: string = (await (await request.post(root + '/shadowrocket/download-link', { headers })).json()).subscriptionUrl;
  const servedRevision = async (url: string) => Number((await request.get(url)).headers()['x-config-revision']);
  await login(page, initial);
  const overview = page.getByLabel('设备交付状态');
  await expect(overview.locator('article').filter({ hasText: 'Stash' })).toContainText(`设备可下载版 ${initial.profile.revision}`);
  await expect(overview.locator('article').filter({ hasText: 'Shadowrocket' })).toContainText(`设备可下载版 ${initial.profile.revision}`);
  await overview.locator('article').filter({ hasText: 'Stash' }).getByRole('button', { name: '打开下载' }).click();
  const confirm = async (button: string, dialog: string) => {
    await page.getByRole('button', { name: button, exact: true }).click();
    const modal = page.getByRole('dialog', { name: dialog, exact: true });
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(modal).toBeHidden();
  };
  await confirm('启用手动发布', '启用手动发布？');
  const publishPath = root + '/delivery/stash/publication';
  const staleCommand = { action: 'manual', expectedMode: 'auto', expectedPublicationId: null };
  expect((await request.post(publishPath, { data: staleCommand })).status()).toBe(401);
  expect((await request.post(publishPath, { headers, data: staleCommand })).status()).toBe(428);
  expect((await request.post(publishPath, {
    headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` }, data: staleCommand
  })).status()).toBe(409);

  const added = await request.post(root + '/rules', { headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` },
    data: { type: 'DOMAIN', payload: 'publish-fixture.test', policy: 'REJECT' } });
  expect(added.status()).toBe(201);
  const updated = (await snapshot(request, initial.profile.id)).profile.revision;
  await page.getByRole('button', { name: '刷新快照', exact: true }).click();
  await expect(page.getByText(`当前编辑版 ${updated} 尚未发布到 Stash。`)).toBeVisible();
  expect(await servedRevision(stashLink)).toBe(initial.profile.revision);
  expect(await servedRevision(shadowLink)).toBe(updated);

  await confirm('发布当前编辑版', '发布当前编辑版？');
  expect(await servedRevision(stashLink)).toBe(updated);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 YAML', exact: true }).click();
  await downloaded;
  await expect(page.getByRole('status').filter({ hasText: `已下载 Stash 版本 ${updated}` })).toBeVisible();
  await page.getByText('查看已发布版本', { exact: true }).click();
  await confirm(`回退到版本 ${initial.profile.revision}`, '回退设备版本？');
  expect(await servedRevision(stashLink)).toBe(initial.profile.revision);
  expect(await servedRevision(shadowLink)).toBe(updated);
  expect((await snapshot(request, initial.profile.id)).profile.revision).toBe(updated);
  await confirm('恢复自动发布', '恢复自动发布？');
  expect(await servedRevision(stashLink)).toBe(updated);
});

test('Monaco previews the served file lazily and downloads the exact preview across targets', async ({ page, request }) => {
  const initial = await create(request, 'artifact-preview', 'rules: ["DOMAIN,preview-only.test,REJECT", "MATCH,DIRECT"]');
  const profileId = initial.profile.id;
  const root = `/api/profiles/${profileId}`;
  const previewPath = (target: string) => `${root}/delivery/${target}/preview`;
  expect((await request.get(previewPath('stash'))).status()).toBe(401);
  const seen: string[] = [];
  const editorFailures: string[] = [];
  page.on('request', req => { if (new URL(req.url()).pathname.endsWith('/preview')) seen.push(req.url()); });
  page.on('console', message => {
    const text = message.text();
    if (/could not create web worker|violates the following content security policy/i.test(text)) editorFailures.push(text);
  });
  await login(page, initial);
  await navigate(page, '下载配置');
  const toggle = page.getByRole('button', { name: '预览导出配置', exact: true });
  await expect(toggle).toBeEnabled();
  expect(seen).toHaveLength(0);
  const previewLoaded = page.waitForResponse(response => response.url().endsWith(previewPath('stash')));
  await toggle.click();
  const response = await previewLoaded;
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['x-config-revision']).toBe(String(initial.profile.revision));
  const panel = page.getByLabel('导出配置预览', { exact: true });
  await expect(panel).toContainText(`版本 ${initial.profile.revision}`);
  await expect(panel.locator('.monaco-editor .view-lines')).toContainText('preview-only.test');
  await expect(panel.locator('.monaco-editor textarea')).toHaveJSProperty('readOnly', true);
  await panel.getByRole('button', { name: '搜索配置', exact: true }).click();
  const find = panel.locator('.find-widget');
  await expect(find).toBeVisible();
  await find.getByRole('textbox').first().fill('preview-only.test');
  await expect(find).toContainText('1 of 1');
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: '下载此预览', exact: true }).click();
  const downloaded = readFileSync((await (await download).path())!);
  expect(createHash('sha256').update(downloaded).digest('hex')).toBe(response.headers()['x-config-sha256']);
  const ordinary = await request.get(root + '/config_download', { headers });
  expect(await ordinary.body()).toEqual(downloaded);

  await page.getByRole('button', { name: 'Shadowrocket', exact: true }).click();
  await expect(panel.getByRole('heading')).toHaveText('Shadowrocket 导出配置预览');
  await expect(panel.locator('.monaco-editor .view-lines')).toContainText('FINAL,DIRECT');
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(seen).toHaveLength(2);
  expect(editorFailures).toEqual([]);
});

test('touch browsers can read and download a configuration preview at phone width', async ({ browser, request }) => {
  const initial = await create(request, 'touch-preview');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await login(page, initial);
    await page.locator('.mobile-nav').getByRole('button', { name: '交付', exact: true }).click();
    await page.getByRole('button', { name: '预览导出配置', exact: true }).click();
    const plain = page.getByRole('textbox', { name: '导出配置内容（只读）' });
    await expect(plain).toHaveValue(/MATCH,DIRECT/);
    await expect(plain).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: '下载此预览', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  } finally {
    await context.close();
  }
});
