import { createHash, randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { decryptJson, encryptJson } from './crypto';
import { getDb, transaction } from './db';
import { HttpError } from './http';
import { getProfileRow, now } from './repository-shared';
import { isJsonObject } from './types';

export type StashOverrideKind = 'override' | 'script';

export interface StashOverrideItem {
  id: number;
  profileId: number;
  slug: string;
  name: string;
  description: string;
  kind: StashOverrideKind;
  enabled: boolean;
  content: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_CONTENT_BYTES = 256 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export const stashOverrideSchema = z.object({
  slug: z.string().trim().regex(SLUG_RE, '标识仅支持小写字母、数字、点、下划线和连字符（1–80 字符）。'),
  name: z.string().trim().min(1, '请填写名称。').max(120),
  description: z.string().trim().max(400).default(''),
  kind: z.enum(['override', 'script']),
  enabled: z.boolean().default(true),
  content: z.string().min(1, '内容不能为空。').refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_CONTENT_BYTES,
    '单个覆写或脚本不能超过 256 KB。'
  )
});

export type StashOverrideInput = z.infer<typeof stashOverrideSchema>;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function assertValidContent(kind: StashOverrideKind, content: string) {
  if (kind !== 'override') return;
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    throw new HttpError(400, 'Stash 覆写必须是有效的 YAML 格式。');
  }
  if (!isJsonObject(parsed)) {
    throw new HttpError(400, 'Stash 覆写顶层必须是 YAML 对象（映射）。');
  }
}

function mapRow(row: Record<string, unknown>): StashOverrideItem {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description || ''),
    kind: String(row.kind) as StashOverrideKind,
    enabled: Boolean(row.enabled),
    content: decryptJson<string>(String(row.content_ciphertext)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function readOverrideToken(profileId: number): string | null {
  const db = getDb();
  getProfileRow(db, profileId);
  const row = db
    .prepare('SELECT token_ciphertext FROM stash_override_links WHERE profile_id = ?')
    .get(profileId) as { token_ciphertext: string } | undefined;
  return row ? decryptJson<string>(row.token_ciphertext) : null;
}

export function rotateOverrideToken(profileId: number): string {
  return transaction((db) => {
    getProfileRow(db, profileId);
    const token = randomBytes(32).toString('base64url');
    db.prepare(
      `INSERT INTO stash_override_links (profile_id, token_hash, token_ciphertext, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         token_ciphertext = excluded.token_ciphertext,
         created_at = excluded.created_at`
    ).run(profileId, tokenHash(token), encryptJson(token), now());
    return token;
  });
}

export function revokeOverrideToken(profileId: number): void {
  transaction((db) => {
    getProfileRow(db, profileId);
    db.prepare('DELETE FROM stash_override_links WHERE profile_id = ?').run(profileId);
  });
}

export function listStashOverrides(profileId: number) {
  const db = getDb();
  getProfileRow(db, profileId);
  const rows = db
    .prepare('SELECT * FROM stash_overrides WHERE profile_id = ? ORDER BY kind ASC, slug ASC')
    .all(profileId) as Record<string, unknown>[];
  const token = readOverrideToken(profileId);
  return {
    items: rows.map(mapRow),
    tokenConfigured: Boolean(token),
    basePath: token ? `/api/override_download/${token}` : null
  };
}

export function createStashOverride(profileId: number, rawInput: StashOverrideInput): StashOverrideItem {
  const input = stashOverrideSchema.parse(rawInput);
  assertValidContent(input.kind, input.content);
  return transaction((db) => {
    getProfileRow(db, profileId);
    const dup = db
      .prepare('SELECT id FROM stash_overrides WHERE profile_id = ? AND slug = ?')
      .get(profileId, input.slug);
    if (dup) throw new HttpError(409, `已存在相同标识的覆写或脚本：“${input.slug}”。`);
    const ts = now();
    const res = db
      .prepare(
        `INSERT INTO stash_overrides
          (profile_id, slug, name, description, kind, enabled, content_ciphertext, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        input.slug,
        input.name,
        input.description,
        input.kind,
        Number(input.enabled),
        encryptJson(input.content),
        ts,
        ts
      );
    const created = db
      .prepare('SELECT * FROM stash_overrides WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
    return mapRow(created);
  });
}

export function updateStashOverride(
  profileId: number,
  overrideId: number,
  rawInput: StashOverrideInput
): StashOverrideItem {
  const input = stashOverrideSchema.parse(rawInput);
  assertValidContent(input.kind, input.content);
  return transaction((db) => {
    getProfileRow(db, profileId);
    const existing = db
      .prepare('SELECT id FROM stash_overrides WHERE id = ? AND profile_id = ?')
      .get(overrideId, profileId);
    if (!existing) throw new HttpError(404, '覆写或脚本不存在。');
    const dup = db
      .prepare('SELECT id FROM stash_overrides WHERE profile_id = ? AND slug = ? AND id != ?')
      .get(profileId, input.slug, overrideId);
    if (dup) throw new HttpError(409, `已存在相同标识的覆写或脚本：“${input.slug}”。`);
    db.prepare(
      `UPDATE stash_overrides
       SET slug = ?, name = ?, description = ?, kind = ?, enabled = ?, content_ciphertext = ?, updated_at = ?
       WHERE id = ? AND profile_id = ?`
    ).run(
      input.slug,
      input.name,
      input.description,
      input.kind,
      Number(input.enabled),
      encryptJson(input.content),
      now(),
      overrideId,
      profileId
    );
    const updated = db
      .prepare('SELECT * FROM stash_overrides WHERE id = ?')
      .get(overrideId) as Record<string, unknown>;
    return mapRow(updated);
  });
}

export function deleteStashOverride(profileId: number, overrideId: number): void {
  transaction((db) => {
    getProfileRow(db, profileId);
    const result = db
      .prepare('DELETE FROM stash_overrides WHERE id = ? AND profile_id = ?')
      .run(overrideId, profileId);
    if (!result.changes) throw new HttpError(404, '覆写或脚本不存在。');
  });
}

export function overrideForToken(token: string, slug: string, baseUrl: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !SLUG_RE.test(slug)) {
    throw new HttpError(404, 'Override link not found');
  }
  const db = getDb();
  const link = db
    .prepare('SELECT profile_id FROM stash_override_links WHERE token_hash = ?')
    .get(tokenHash(token)) as { profile_id: number } | undefined;
  if (!link) throw new HttpError(404, 'Override link not found');
  const row = db
    .prepare('SELECT * FROM stash_overrides WHERE profile_id = ? AND slug = ? AND enabled = 1')
    .get(link.profile_id, slug) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, 'Override item not found');
  const item = mapRow(row);
  const content = item.kind === 'override'
    ? item.content.replaceAll('{{BASE_URL}}', baseUrl.replace(/\/+$/, ''))
    : item.content;
  return {
    slug: item.slug,
    kind: item.kind,
    content,
    contentType: item.kind === 'override'
      ? 'application/yaml; charset=utf-8'
      : 'application/javascript; charset=utf-8'
  };
}

const STARTER_AI_MEDIA_JS = `// Stash Tile: AI & Streaming Unlock Checker
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const BLOCKED = { CN: 1, HK: 1, MO: 1, RU: 1, BY: 1, KP: 1, IR: 1, SY: 1, CU: 1 };

function req(method, opts) {
  return new Promise(resolve => {
    const fn = method === 'HEAD' ? $httpClient.head : $httpClient.get;
    fn(opts, (err, resp, data) => {
      if (err) return resolve({ ok: false, status: 0, headers: {}, data: '' });
      resolve({ ok: true, status: (resp && (resp.status || resp.statusCode)) || 0, headers: (resp && resp.headers) || {}, data: typeof data === 'string' ? data : '' });
    });
  });
}
function locOf(body) { const m = body && body.match(/(?:^|\\n)loc=([A-Z]{2})/); return m ? m[1] : ''; }

(async () => {
  const [gptT, gptA, clT, clL, gem, nf, dp] = await Promise.all([
    req('GET', { url: 'https://chatgpt.com/cdn-cgi/trace', timeout: 4, headers: { 'User-Agent': UA } }),
    req('GET', { url: 'https://api.openai.com/v1/models', timeout: 4, headers: { 'User-Agent': UA } }),
    req('GET', { url: 'https://claude.ai/cdn-cgi/trace', timeout: 4, headers: { 'User-Agent': UA } }),
    req('HEAD', { url: 'https://claude.ai/login', timeout: 4, 'auto-redirect': false, headers: { 'User-Agent': UA } }),
    req('HEAD', { url: 'https://gemini.google.com/', timeout: 4, 'auto-redirect': false, headers: { 'User-Agent': UA } }),
    req('GET', { url: 'https://www.netflix.com/title/81280792', timeout: 4, 'auto-redirect': true, headers: { 'User-Agent': UA } }),
    req('HEAD', { url: 'https://www.disneyplus.com/', timeout: 4, 'auto-redirect': false, headers: { 'User-Agent': UA } })
  ]);
  const gLoc = locOf(gptT.data);
  const cLoc = locOf(clT.data);
  const gpt = gLoc && BLOCKED[gLoc] ? '❌' : (gptA.status === 401 || gptA.status === 200) ? '✅' : '⚠️';
  const cl = cLoc && BLOCKED[cLoc] ? '❌' : (clL.status === 200 || clL.status === 302) ? '✅' : '⚠️';
  const gHdr = gem.headers.location || gem.headers.Location || '';
  const gm = gem.ok && gHdr.indexOf('unsupported') === -1 && [200, 301, 302].includes(gem.status) ? '✅' : '❌';
  const nfx = nf.status === 200 ? '✅ 完整' : nf.status === 404 ? '⚠️ 仅自制' : '❌';
  const dHdr = dp.headers.location || dp.headers.Location || '';
  const dsp = dp.ok && dHdr.indexOf('unavailable') === -1 && [200, 301, 302, 307].includes(dp.status) ? '✅' : '❌';
  $done({
    title: 'AI 与流媒体解锁',
    content: \`ChatGPT: \${gpt}\${gLoc ? ' (' + gLoc + ')' : ''}\\nClaude: \${cl}\${cLoc ? ' (' + cLoc + ')' : ''}\\nGemini: \${gm} · Netflix: \${nfx}\\nDisney+: \${dsp}\`,
    icon: 'sparkles',
    backgroundColor: gpt === '✅' && cl === '✅' ? '#15803D' : '#B45309'
  });
})();
`;

const STARTER_IP_PURITY_JS = `// Stash Tile: Exit IP & Purity Check
function get(url) {
  return new Promise(resolve => {
    $httpClient.get({ url, timeout: 4 }, (err, _resp, data) => resolve(err ? '' : (data || '')));
  });
}
(async () => {
  const [proxyRaw, directRaw] = await Promise.all([
    get('http://ip-api.com/json/?fields=status,countryCode,city,isp,proxy,hosting,query&lang=zh-CN'),
    get('https://myip.ipip.net/json')
  ]);
  let p = null;
  try { const j = JSON.parse(proxyRaw); if (j && j.status === 'success') p = j; } catch (_) {}
  if (!p) {
    $done({ title: '出口 IP 与纯净度', content: '获取代理出口 IP 失败', icon: 'exclamationmark.triangle.fill', backgroundColor: '#B91C1C' });
    return;
  }
  const tag = p.proxy ? '🔴 代理标记' : p.hosting ? '🟡 机房 IP' : '🟢 住宅/ISP';
  const bg = p.proxy ? '#B91C1C' : p.hosting ? '#B45309' : '#0F766E';
  const lines = [\`出口: \${p.query} (\${[p.countryCode, p.city].filter(Boolean).join(' ')})\`, \`性质: \${tag}\`, \`ISP: \${p.isp || '未知'}\`];
  try {
    const d = JSON.parse(directRaw);
    if (d && d.data && d.data.ip) lines.push(\`直连: \${d.data.ip} (\${(d.data.location || []).filter(Boolean).slice(1).join(' ')})\`);
  } catch (_) {}
  $done({ title: '出口 IP 与纯净度', content: lines.join('\\n'), icon: 'network.badge.shield.half.filled', backgroundColor: bg });
})();
`;

const STARTER_OVERRIDE_YAML = `name: "仪表盘磁贴（AI解锁 · IP纯净度）"
desc: "由 Stash Config Forge 托管：纯展示不侵入流量，支持首页展示与长按单节点探测。"

tiles:
  - name: ai-media-check
    title: "AI 与流媒体解锁"
    content: "点击刷新检测 ChatGPT / Claude / Gemini / Netflix / Disney+"
    interval: 1800
    icon: "sparkles"
    backgroundColor: "#15803D"

  - name: ip-purity
    title: "出口 IP 与纯净度"
    content: "点击刷新查看代理出口 IP、ISP 性质与本地直连 IP"
    interval: 1800
    icon: "network.badge.shield.half.filled"
    backgroundColor: "#0F766E"

  - name: ai-media-node-check
    title: "单节点 AI / 流媒体检测"
    content: "长按任意节点触发单测"
    collapsed: true
    icon: "sparkles"
    backgroundColor: "#7C3AED"

  - name: ip-purity-node-check
    title: "单节点 IP 纯净度"
    content: "长按任意节点触发单测"
    collapsed: true
    icon: "network.badge.shield.half.filled"
    backgroundColor: "#0F766E"

script-providers:
  ai-media-check:
    url: "{{BASE_URL}}/ai-media-check.js"
    interval: 86400
  ai-media-node-check:
    url: "{{BASE_URL}}/ai-media-check.js"
    interval: 86400
  ip-purity:
    url: "{{BASE_URL}}/ip-purity.js"
    interval: 86400
  ip-purity-node-check:
    url: "{{BASE_URL}}/ip-purity.js"
    interval: 86400
`;

export function installStarterTileBundle(profileId: number): StashOverrideItem[] {
  const templates: StashOverrideInput[] = [
    {
      slug: 'ai-media-check.js',
      name: 'AI 与流媒体解锁脚本',
      description: '检测 ChatGPT / Claude / Gemini / Netflix / Disney+ 可用性与出口地区。',
      kind: 'script',
      enabled: true,
      content: STARTER_AI_MEDIA_JS
    },
    {
      slug: 'ip-purity.js',
      name: '出口 IP 与纯净度脚本',
      description: '展示代理出口 IP、ISP 性质（住宅/机房/代理标记）与国内直连 IP。',
      kind: 'script',
      enabled: true,
      content: STARTER_IP_PURITY_JS
    },
    {
      slug: 'stash-tiles.stoverride',
      name: '仪表盘磁贴覆写',
      description: '组合 AI 解锁与 IP 纯净度首页磁贴及长按单节点探测磁贴。',
      kind: 'override',
      enabled: true,
      content: STARTER_OVERRIDE_YAML
    }
  ];
  const created: StashOverrideItem[] = [];
  for (const template of templates) {
    const existing = listStashOverrides(profileId).items.find((item) => item.slug === template.slug);
    if (!existing) {
      created.push(createStashOverride(profileId, template));
    }
  }
  return created;
}
