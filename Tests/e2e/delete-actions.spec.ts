import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot } from '../../lib/types';

const token = ['browser', 'test', 'admin'].join('-');
const headers = { 'X-Admin-Token': token };
let sequence = 0;

async function create(request: APIRequestContext, label: string, yaml: string): Promise<Snapshot> {
  const response = await request.post('/api/profiles', {
    headers,
    data: { name: `${label}-${Date.now()}-${++sequence}`, importYaml: yaml }
  });
  expect(response.status()).toBe(201);
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

async function deleteWithInAppConfirmation(
  page: Page,
  request: APIRequestContext,
  profile: Snapshot,
  section: string,
  deleteButtonName: string,
  expectedPath: RegExp
) {
  await navigate(page, section);
  const deletes: Array<{ url: string; ifMatch: string | null }> = [];
  page.on('request', (req) => {
    if (req.method() === 'DELETE') {
      deletes.push({ url: req.url(), ifMatch: req.headers()['if-match'] ?? null });
    }
  });

  await page.getByRole('button', { name: deleteButtonName, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('删除会生成一个新的配置修订');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();

  await expect.poll(() => deletes.length).toBe(1);
  expect(deletes[0].url).toMatch(expectedPath);
  expect(deletes[0].ifMatch).toBe(`"${profile.profile.revision}"`);

  await expect.poll(async () => {
    const response = await request.get(`/api/profiles/${profile.profile.id}/snapshot`, { headers });
    expect(response.ok()).toBeTruthy();
    const current = (await response.json()) as Snapshot;
    return current.profile.revision;
  }).toBe(profile.profile.revision + 1);
}

test('deleting a host opens an in-app confirmation and sends If-Match', async ({ page, request }) => {
  const profile = await create(request, 'delete-host', 'hosts: { probe.test: 192.0.2.1 }\nrules: ["MATCH,DIRECT"]');
  await login(page, profile);
  await deleteWithInAppConfirmation(page, request, profile, 'Hosts', '删除 probe.test', /\/hosts\/\d+$/);
});

test('deleting a rule opens an in-app confirmation and sends If-Match', async ({ page, request }) => {
  const profile = await create(request, 'delete-rule', 'rules: ["DOMAIN,a.test,DIRECT", "MATCH,DIRECT"]');
  await login(page, profile);
  await deleteWithInAppConfirmation(page, request, profile, '路由规则', '删除', /\/rules\/\d+$/);
});

test('deleting a strategy group opens an in-app confirmation and sends If-Match', async ({ page, request }) => {
  const profile = await create(request, 'delete-group', 'proxy-groups: [{ name: probe, type: select, proxies: [DIRECT] }]\nrules: ["MATCH,DIRECT"]');
  await login(page, profile);
  await deleteWithInAppConfirmation(page, request, profile, '策略组', '删除 probe', /\/proxy-groups\/\d+$/);
});

test('deleting a rule provider opens an in-app confirmation and sends If-Match', async ({ page, request }) => {
  const profile = await create(request, 'delete-provider', 'rule-providers: { probe: { type: inline, behavior: domain, payload: [a.test] } }\nrules: ["MATCH,DIRECT"]');
  await login(page, profile);
  await deleteWithInAppConfirmation(page, request, profile, '规则集', '删除 probe', /\/rule-providers\/\d+$/);
});

test('deleting a proxy opens an in-app confirmation and sends If-Match', async ({ page, request }) => {
  const profile = await create(request, 'delete-proxy', 'proxies: [{ name: probe, type: ss, server: example.com, port: 443, cipher: aes-128-gcm }]\nrules: ["MATCH,DIRECT"]');
  await login(page, profile);
  await deleteWithInAppConfirmation(page, request, profile, '直接节点', '删除 probe', /\/proxies\/\d+$/);
});

test('a referenced resource stays intact and reports the reference instead of failing silently', async ({ page, request }) => {
  const profile = await create(
    request,
    'delete-referenced',
    'rule-providers: { probe: { type: inline, behavior: domain, payload: [a.test] } }\nrules: ["RULE-SET,probe,DIRECT", "MATCH,DIRECT"]'
  );
  await login(page, profile);
  await navigate(page, '规则集');
  await page.getByRole('button', { name: '删除 probe', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.toast-bad')).toContainText('still referenced');

  const current = (await (await request.get(`/api/profiles/${profile.profile.id}/snapshot`, { headers })).json()) as Snapshot;
  expect(current.ruleProviders.some((provider) => provider.name === 'probe')).toBeTruthy();
  expect(current.profile.revision).toBe(profile.profile.revision);
});
