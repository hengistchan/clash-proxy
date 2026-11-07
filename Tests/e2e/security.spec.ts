import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { Snapshot } from '../../lib/types';

const testToken = ['browser', 'test', 'admin'].join('-');
const headers = { 'X-Admin-Token': testToken };
const images = '/tmp/forge-security-acceptance';
let sequence = 0;

async function create(request: APIRequestContext, label: string, yaml?: string): Promise<Snapshot> {
  const response = await request.post('/api/profiles', {
    headers,
    data: { name: `${label}-${Date.now()}-${++sequence}`, ...(yaml ? { importYaml: yaml } : {}) }
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function snapshot(request: APIRequestContext, profileId: number): Promise<Snapshot> {
  const response = await request.get(`/api/profiles/${profileId}/snapshot`, { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function login(page: Page, profile: Snapshot) {
  await page.addInitScript((id) => sessionStorage.setItem('stash-profile-id', String(id)), profile.profile.id);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '进入配置控制台' })).toBeVisible();
  await page.getByLabel('管理员令牌').fill(testToken);
  await page.getByRole('button', { name: '验证并连接' }).click();
  await expect(page.getByRole('heading', { name: profile.profile.name, exact: true })).toBeVisible();
}

async function navigate(page: Page, section: string) {
  await page.locator('.side-nav').getByRole('button', { name: section, exact: true }).click();
}

test('production management rejects missing authentication and forged local proxy headers before revision checks', async ({ request }) => {
  const profile = await create(request, 'production-auth-boundary');
  const id = profile.profile.id;
  for (const forged of [
    {},
    { Host: 'localhost', 'X-Forwarded-Host': 'localhost', 'X-Forwarded-For': '127.0.0.1', Origin: 'http://localhost' },
    { Host: '127.0.0.1', 'X-Forwarded-Proto': 'https', 'X-Admin-Token': 'incorrect-dynamic-test-value' }
  ] as Array<Record<string, string>>) {
    for (const endpoint of ['snapshot', 'config_download', 'relationships', 'revisions']) {
      expect((await request.get(`/api/profiles/${id}/${endpoint}`, { headers: forged })).status()).toBe(401);
    }
    expect((await request.put(`/api/profiles/${id}/settings`, {
      headers: { ...forged, 'If-Match': `"${profile.profile.revision}"` },
      data: { mode: 'rule', logLevel: 'silent', settings: { dns: { nameserver: ['https://untrusted.example.test/dns-query'] } } }
    })).status()).toBe(401);
  }
  const noPrecondition = await request.put(`/api/profiles/${id}/settings`, { headers, data: { mode: 'rule', logLevel: 'silent', settings: { dns: {} } } });
  expect(noPrecondition.status()).toBe(428);
  expect((await noPrecondition.json()).code).toBe('revision.required');
  const weakPrecondition = await request.put(`/api/profiles/${id}/settings`, {
    headers: { ...headers, 'If-Match': `W/"${profile.profile.revision}"` }, data: { mode: 'rule', logLevel: 'silent', settings: { dns: {} } }
  });
  expect(weakPrecondition.status()).toBe(400);
  expect((await snapshot(request, id)).profile.revision).toBe(profile.profile.revision);
});

test('two browser tabs cannot silently overwrite a newer configuration and retain the losing draft', async ({ page, context, request }) => {
  const initial = await create(request, 'two-client-concurrency');
  const second = await context.newPage();
  try {
    await login(page, initial);
    await login(second, initial);
    await navigate(page, '全局与 DNS');
    await navigate(second, '全局与 DNS');
    const firstDns = page.getByRole('textbox', { name: 'nameserver', exact: true });
    const secondDns = second.getByRole('textbox', { name: 'nameserver', exact: true });
    const firstValue = 'https://first-client.example.test/dns-query';
    const secondValue = 'https://second-client.example.test/dns-query';
    await firstDns.fill(firstValue);
    await secondDns.fill(secondValue);
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/profiles/${initial.profile.id}/settings`) && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    const conflict = second.waitForResponse((response) => response.url().endsWith(`/api/profiles/${initial.profile.id}/settings`) && response.request().method() === 'PUT');
    await second.getByRole('button', { name: '保存设置', exact: true }).click();
    const rejected = await conflict;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().headers()['if-match']).toBe(`"${initial.profile.revision}"`);
    expect((await rejected.json()).code).toBe('revision.conflict');
    await expect(second.locator('.settings-panel').getByRole('alert')).toContainText('本页输入仍保留');
    await expect(secondDns).toHaveValue(secondValue);
    let stored = await snapshot(request, initial.profile.id);
    expect(stored.profile.revision).toBe(initial.profile.revision + 1);
    expect(stored.profile.settings.dns).toMatchObject({ nameserver: [firstValue] });
    second.once('dialog', (dialog) => dialog.dismiss());
    await second.getByRole('button', { name: '刷新快照', exact: true }).click();
    await expect(secondDns).toHaveValue(secondValue);
    const stillStale = second.waitForResponse((response) => response.url().endsWith(`/api/profiles/${initial.profile.id}/settings`) && response.request().method() === 'PUT');
    await second.getByRole('button', { name: '保存设置', exact: true }).click();
    expect((await stillStale).status()).toBe(409);
    stored = await snapshot(request, initial.profile.id);
    expect(stored.profile.revision).toBe(initial.profile.revision + 1);
    expect(stored.profile.settings.dns).toMatchObject({ nameserver: [firstValue] });
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '放弃本页修改并读取最新配置', exact: true }).click();
    await expect(secondDns).toHaveValue(firstValue);
    await expect(second.locator('.settings-panel').getByRole('alert')).toBeHidden();
  } finally { await second.close(); }
});

test('an import preview cannot authorize replacement after another client writes a new revision', async ({ page, request }) => {
  const initial = await create(request, 'stale-import-preview', 'hosts: { original.test: 192.0.2.1 }\nrules: ["MATCH,DIRECT"]');
  await login(page, initial);
  await page.getByRole('button', { name: '导入配置文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入并替换当前 Profile' });
  const yaml = 'hosts: { replacement.test: 192.0.2.2 }\nrules: ["MATCH,DIRECT"]';
  await dialog.getByRole('textbox').fill(yaml);
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '导入完整 YAML', exact: true })).toBeEnabled();
  const otherWrite = await request.post(`/api/profiles/${initial.profile.id}/hosts`, {
    headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` }, data: { pattern: 'other-client.test', value: '192.0.2.3' }
  });
  expect(otherWrite.status()).toBe(201);
  const rejected = page.waitForResponse((response) => response.url().endsWith(`/api/profiles/${initial.profile.id}/import`) && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '导入完整 YAML', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue(yaml);
  let stored = await snapshot(request, initial.profile.id);
  expect(stored.hosts.map((entry) => entry.pattern)).toContain('other-client.test');
  expect(stored.hosts.map((entry) => entry.pattern)).not.toContain('replacement.test');
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(dialog.getByText(`基于当前版本 ${stored.profile.revision} 的替换预览。修改导入文本后需要重新预览。`)).toBeVisible();
  await dialog.getByRole('button', { name: '导入完整 YAML', exact: true }).click();
  await expect(dialog).toBeHidden();
  stored = await snapshot(request, initial.profile.id);
  expect(stored.hosts.map((entry) => entry.pattern)).toEqual(['replacement.test']);
});

test('batch rule edits update selected rules in one revision while protecting MATCH', async ({ page, request }) => {
  const initial = await create(request, 'batch-rule-change', 'rules:\n  - DOMAIN,first-batch.test,DIRECT\n  - DOMAIN,second-batch.test,DIRECT\n  - DOMAIN,untouched-batch.test,DIRECT\n  - MATCH,DIRECT\n');
  await login(page, initial);
  await navigate(page, '路由规则');
  await page.getByRole('checkbox', { name: '选择规则 1', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择规则 2', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '选择规则 4', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '批量目标策略', exact: true }).click();
  await page.getByRole('option', { name: 'REJECT', exact: true }).click();
  const write = page.waitForResponse((response) => response.url().endsWith(`/api/profiles/${initial.profile.id}/rules/batch`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '批量改策略', exact: true }).click();
  expect((await write).status()).toBe(200);
  await expect(page.getByRole('button', { name: '批量改策略', exact: true })).toBeEnabled();
  const updated = await snapshot(request, initial.profile.id);
  expect(updated.profile.revision).toBe(initial.profile.revision + 1);
  expect(updated.rules.map((rule) => rule.policy)).toEqual(['REJECT', 'REJECT', 'DIRECT', 'DIRECT']);
  const revisions = await (await request.get(`/api/profiles/${initial.profile.id}/revisions`, { headers })).json();
  expect(revisions.items).toHaveLength(2);
  expect(updated.rules.at(-1)).toMatchObject({ type: 'MATCH', enabled: true });
});

test('phone layout keeps primary controls usable and avoids horizontal page overflow', async ({ page, request }) => {
  const initial = await create(request, 'phone-layout', 'rules:\n  - DOMAIN,mobile-fixture.example.test,DIRECT\n  - MATCH,DIRECT\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, initial);
  mkdirSync(images, { recursive: true });
  await page.screenshot({ path: `${images}/overview-390.png`, fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const metadata = await page.locator('.overview-hero p:not(.kicker)').boundingBox();
  const badge = await page.locator('.overview-hero .status-badge').boundingBox();
  expect(metadata).not.toBeNull();
  expect(badge?.y).toBeGreaterThanOrEqual(metadata!.y + metadata!.height - 0.5);
  for (const name of ['导入配置文件', '新建配置', '下载配置']) {
    const button = page.locator('.topbar-actions').getByRole('button', { name, exact: true });
    const bounds = await button.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator('.mobile-nav').getByRole('button', { name: '路由规则', exact: true }).click();
  await expect(page.getByRole('heading', { name: '路由规则', exact: true })).toBeVisible();
  await page.screenshot({ path: `${images}/rules-390.png`, fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await page.locator('.rule-card .icon-button:visible').all()) {
    const bounds = await button.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds?.width).toBeGreaterThanOrEqual(44);
  }
});
