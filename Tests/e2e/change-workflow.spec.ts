import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../../lib/types';

const token = ['browser', 'test', 'admin'].join('-');
const headers = { 'X-Admin-Token': token };
let sequence = 0;
async function create(request: APIRequestContext, label: string, yaml?: string): Promise<Snapshot> {
  const response = await request.post('/api/profiles', { headers, data: { name: `${label}-${Date.now()}-${++sequence}`, ...(yaml ? { importYaml: yaml } : {}) } });
  expect(response.status()).toBe(201);
  return response.json();
}
async function read(request: APIRequestContext, profileId: number): Promise<Snapshot> {
  const response = await request.get(`/api/profiles/${profileId}/snapshot`, { headers });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function login(page: Page, profile: Snapshot) {
  await page.addInitScript((id) => sessionStorage.setItem('stash-profile-id', String(id)), profile.profile.id);
  await page.goto('/');
  await page.getByLabel('管理员令牌').fill(token);
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: profile.profile.name, exact: true })).toBeVisible();
}
async function navigate(page: Page, section: string) {
  await page.locator('.side-nav').getByRole('button', { name: section, exact: true }).click();
}

test('batch policy, priority and enable changes each create one revision and protect MATCH', async ({ page, request }) => {
  const initial = await create(request, 'batch-browser', 'rules: ["DOMAIN,a.test,DIRECT", "DOMAIN,b.test,DIRECT", "DOMAIN,c.test,DIRECT", "MATCH,DIRECT"]');
  await login(page, initial);
  await navigate(page, '路由规则');
  await page.getByRole('checkbox', { name: '选择规则 1', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择规则 2', exact: true }).check();
  const toolbar = page.getByLabel('批量规则操作');
  await toolbar.getByRole('combobox').click();
  await page.getByRole('option', { name: 'REJECT', exact: true }).click();
  await toolbar.getByRole('button', { name: '批量改策略', exact: true }).click();
  await expect.poll(async () => (await read(request, initial.profile.id)).profile.revision).toBe(initial.profile.revision + 1);
  let current = await read(request, initial.profile.id);
  expect(current.rules.map((rule) => rule.policy)).toEqual(['REJECT', 'REJECT', 'DIRECT', 'DIRECT']);
  await toolbar.getByRole('button', { name: '移到兜底前', exact: true }).click();
  await expect.poll(async () => (await read(request, initial.profile.id)).profile.revision).toBe(initial.profile.revision + 2);
  current = await read(request, initial.profile.id);
  expect(current.rules.map((rule) => rule.payload)).toEqual(['c.test', 'a.test', 'b.test', '']);
  await toolbar.getByRole('button', { name: '批量停用', exact: true }).click();
  await expect.poll(async () => (await read(request, initial.profile.id)).profile.revision).toBe(initial.profile.revision + 3);
  current = await read(request, initial.profile.id);
  expect(current.rules.map((rule) => rule.enabled)).toEqual([true, false, false, true]);
  expect(await page.getByRole('checkbox', { name: /^选择规则 / }).count()).toBe(3);
});

test('import previews are read-only and changing the YAML invalidates the confirmation', async ({ page, request }) => {
  const initial = await create(request, 'preview-browser', 'hosts: { original.test: 192.0.2.1 }\nrules: ["MATCH,DIRECT"]');
  await login(page, initial);
  await page.getByRole('button', { name: '导入配置文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入并替换当前 Profile' });
  const confirm = dialog.getByRole('button', { name: '导入完整 YAML', exact: true });
  await dialog.getByRole('textbox').fill('# private formatting will normalize\nhosts: { next.test: 192.0.2.2 }\nrules: ["MATCH,DIRECT"]');
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByText(/注释、原始排版和锚点写法不会保留/)).toBeVisible();
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(confirm).toBeEnabled();
  await expect(dialog.locator('.diff-summary')).toContainText('新增 1 项 · 删除 1 项');
  expect((await read(request, initial.profile.id)).profile.revision).toBe(initial.profile.revision);
  await dialog.getByRole('textbox').fill('hosts: { final.test: 192.0.2.3 }\nrules: ["MATCH,DIRECT"]');
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('button', { name: '预览导入变化', exact: true }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read(request, initial.profile.id)).hosts[0]?.pattern).toBe('final.test');
});

test('history displays a secret-free semantic diff and restores only after explicit confirmation', async ({ page, request }) => {
  const initial = await create(request, 'history-preview-browser');
  const changed = await request.post(`/api/profiles/${initial.profile.id}/hosts`, { headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` }, data: { pattern: 'changed.test', value: '192.0.2.55' } });
  expect(changed.status()).toBe(201);
  const current = await read(request, initial.profile.id);
  await login(page, current);
  await navigate(page, '版本');
  await expect(page.getByText(/保留最近 200 个版本/)).toBeVisible();
  await page.locator('.timeline-item').last().getByRole('button', { name: '查看变化', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `恢复版本 ${initial.profile.revision} 前的变化` });
  await expect(dialog.locator('.diff-summary')).toContainText('删除 1 项');
  await expect(dialog.locator('.config-diff')).not.toContainText('192.0.2.55');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await read(request, initial.profile.id)).profile.revision).toBe(current.profile.revision);
  await page.locator('.timeline-item').last().getByRole('button', { name: '查看变化', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read(request, initial.profile.id)).hosts.length).toBe(0);
  expect((await read(request, initial.profile.id)).profile.revision).toBe(current.profile.revision + 1);
});

test('mobile rule editing keeps touch controls at least 44 pixels without page overflow', async ({ page, request }) => {
  const initial = await create(request, 'mobile-browser', 'rules: ["DOMAIN,mobile.test,DIRECT", "MATCH,DIRECT"]');
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, initial);
  await page.locator('.mobile-nav').getByRole('button', { name: '路由规则', exact: true }).click();
  await expect(page.getByRole('heading', { name: '路由规则', exact: true })).toBeVisible();
  const edit = page.locator('.rule-card').first().getByRole('button', { name: '编辑', exact: true });
  const box = await edit.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44);
  const navigation = await page.locator('.mobile-nav').getByRole('button', { name: '路由规则', exact: true }).boundingBox();
  expect(navigation?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await edit.click();
  const dialog = page.getByRole('dialog', { name: '编辑路由规则' });
  await expect(dialog).toBeVisible();
  const close = await dialog.getByRole('button', { name: '关闭', exact: true }).boundingBox();
  expect(close?.width).toBeGreaterThanOrEqual(44); expect(close?.height).toBeGreaterThanOrEqual(44);
});

test('stale history confirmation preserves newer changes and requires a newly generated diff', async ({ page, request }) => {
  const initial = await create(request, 'history-conflict-browser');
  const firstChange = await request.post(`/api/profiles/${initial.profile.id}/hosts`, { headers: { ...headers, 'If-Match': `"${initial.profile.revision}"` }, data: { pattern: 'first.test', value: '192.0.2.1' } });
  expect(firstChange.status()).toBe(201);
  const current = await read(request, initial.profile.id);
  await login(page, current);
  await navigate(page, '版本');
  await page.locator('.timeline-item').last().getByRole('button', { name: '查看变化', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `恢复版本 ${initial.profile.revision} 前的变化` });
  await expect(dialog.getByRole('button', { name: '确认恢复', exact: true })).toBeEnabled();
  const later = await request.post(`/api/profiles/${initial.profile.id}/hosts`, { headers: { ...headers, 'If-Match': `"${current.profile.revision}"` }, data: { pattern: 'newer.test', value: '192.0.2.2' } });
  expect(later.status()).toBe(201);
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await read(request, initial.profile.id)).hosts).toHaveLength(2);
  await dialog.getByRole('button', { name: '重新预览', exact: true }).click();
  await expect(dialog.locator('.diff-summary')).toContainText('删除 2 项');
  await expect(dialog.getByRole('button', { name: '确认恢复', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await read(request, initial.profile.id)).hosts.length).toBe(0);
});
