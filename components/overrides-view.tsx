'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';

import type { StashOverrideItem, StashOverrideKind } from '@/lib/stash-overrides';

import { apiRequest } from './api-client';
import { Modal, SelectField, SwitchField } from './ui';
import { useUnsavedChanges } from './unsaved-changes';

interface OverrideListResponse {
  items: StashOverrideItem[];
  tokenConfigured: boolean;
  basePath: string | null;
  baseUrl: string | null;
}

interface DraftState {
  id?: number;
  slug: string;
  name: string;
  description: string;
  kind: StashOverrideKind;
  enabled: boolean;
  content: string;
}

const EMPTY_DRAFT: DraftState = {
  slug: 'custom.stoverride',
  name: '',
  description: '',
  kind: 'override',
  enabled: true,
  content: 'name: "自定义覆写"\ndesc: ""\n\ntiles: []\n'
};

export function OverridesView({
  profileId,
  token
}: {
  profileId: number;
  token: string;
}) {
  const [items, setItems] = useState<StashOverrideItem[]>([]);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StashOverrideItem | null>(null);
  const [pendingLinkAction, setPendingLinkAction] = useState<'rotate' | 'revoke' | null>(null);

  useUnsavedChanges(Boolean(draft), working, () => setDraft(null));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<OverrideListResponse>(
        `/api/profiles/${profileId}/overrides`,
        { token }
      );
      setItems(data.items);
      setBaseUrl(data.baseUrl);
      setTokenConfigured(data.tokenConfigured);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载 Stash 覆写列表');
    } finally {
      setLoading(false);
    }
  }, [profileId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function installStarter() {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const data = await apiRequest<OverrideListResponse & { installed: number }>(
        `/api/profiles/${profileId}/overrides`,
        {
          method: 'POST',
          token,
          body: JSON.stringify({ preset: 'starter-tiles' })
        }
      );
      setItems(data.items);
      setBaseUrl(data.baseUrl);
      setTokenConfigured(data.tokenConfigured);
      setNotice(data.installed ? `已安装 ${data.installed} 个仪表盘磁贴模板文件。` : '磁贴模板文件已存在，未重复覆盖。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '安装模板失败');
    } finally {
      setWorking(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const endpoint = draft.id
        ? `/api/profiles/${profileId}/overrides/${draft.id}`
        : `/api/profiles/${profileId}/overrides`;
      await apiRequest(endpoint, {
        method: draft.id ? 'PUT' : 'POST',
        token,
        body: JSON.stringify({
          slug: draft.slug,
          name: draft.name,
          description: draft.description,
          kind: draft.kind,
          enabled: draft.enabled,
          content: draft.content
        })
      });
      setDraft(null);
      setNotice('覆写/脚本已保存。');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setWorking(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/api/profiles/${profileId}/overrides/${pendingDelete.id}`, {
        method: 'DELETE',
        token
      });
      setPendingDelete(null);
      setNotice('已删除。');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除失败');
    } finally {
      setWorking(false);
    }
  }

  async function runLinkAction(action: 'rotate' | 'revoke') {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      if (action === 'rotate') {
        const data = await apiRequest<OverrideListResponse>(
          `/api/profiles/${profileId}/overrides/download-link`,
          { method: 'POST', token }
        );
        setItems(data.items);
        setBaseUrl(data.baseUrl);
        setTokenConfigured(data.tokenConfigured);
        setNotice('已生成新的只读覆写订阅令牌。');
      } else {
        await apiRequest(`/api/profiles/${profileId}/overrides/download-link`, {
          method: 'DELETE',
          token
        });
        setBaseUrl(null);
        setTokenConfigured(false);
        setNotice('已撤销覆写订阅链接。');
      }
      setPendingLinkAction(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新链接失败');
    } finally {
      setWorking(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice('已复制订阅地址。');
    } catch {
      setNotice(`请手动复制：${url}`);
    }
  }

  return (
    <section className="panel" aria-busy={loading || working}>
      <div className="panel-heading">
        <div>
          <p className="kicker">STASH / OVERRIDES &amp; TILES</p>
          <h2>Stash 覆写与磁贴脚本</h2>
          <p>
            统一加密托管 Stash 专属 <code>.stoverride</code> 与磁贴 JS 脚本（纳入 SQLite 在线备份）。在 <code>.stoverride</code> 中使用 <code>{'{{BASE_URL}}'}</code> 会自动展开为当前只读链接前缀。
          </p>
        </div>
        <div className="delivery-actions">
          <button
            className="button secondary"
            disabled={working}
            onClick={() => void installStarter()}
          >
            <Sparkles size={15} />
            导入磁贴模板（AI 解锁 + IP 纯净度）
          </button>
          <button
            className="button primary"
            disabled={working}
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            <Plus size={15} />
            新建覆写 / 脚本
          </button>
        </div>
      </div>

      {notice ? <p className="delivery-note" role="status">{notice}</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}

      <div className="section-rule"><span>设备只读订阅令牌</span></div>
      <div className="delivery-actions" style={{ marginBottom: '1rem' }}>
        <p className="delivery-note" style={{ margin: 0, flex: 1 }}>
          {tokenConfigured && baseUrl
            ? `已启用只读订阅前缀：${baseUrl}/<标识>`
            : '尚未生成覆写只读订阅链接；生成后可直接把 .stoverride 链接导入 iPhone Stash。'}
        </p>
        <button
          className="button secondary small"
          disabled={working}
          onClick={() => setPendingLinkAction('rotate')}
        >
          <RefreshCw size={14} />
          {tokenConfigured ? '更换链接令牌' : '生成订阅链接'}
        </button>
        {tokenConfigured ? (
          <button
            className="button danger small"
            disabled={working}
            onClick={() => setPendingLinkAction('revoke')}
          >
            撤销链接
          </button>
        ) : null}
      </div>

      <div className="section-rule"><span>已托管的覆写与脚本（{items.length}）</span></div>
      {loading ? (
        <p className="delivery-note">正在加载…</p>
      ) : items.length === 0 ? (
        <p className="delivery-note">暂无托管文件。点击右上角可一键导入 AI 解锁与 IP 纯净度磁贴模板，或新建自定义覆写。</p>
      ) : (
        <ul className="delivery-release-list">
          {items.map((item) => {
            const downloadUrl = baseUrl && item.enabled ? `${baseUrl}/${item.slug}` : null;
            return (
              <li key={item.id}>
                <div>
                  <strong>{item.name}</strong>{' '}
                  <code>{item.slug}</code>{' '}
                  <span className="delivery-note">
                    ({item.kind === 'override' ? 'Stash 覆写' : 'JS 脚本'} · {item.enabled ? '已启用' : '已停用'})
                  </span>
                  {item.description ? <p className="delivery-note">{item.description}</p> : null}
                  {downloadUrl ? <p className="delivery-note mono">{downloadUrl}</p> : null}
                </div>
                <div className="delivery-actions">
                  {downloadUrl ? (
                    <button
                      className="button secondary small"
                      onClick={() => void copyUrl(downloadUrl)}
                    >
                      <Copy size={13} />
                      复制链接
                    </button>
                  ) : null}
                  <button
                    className="button secondary small"
                    disabled={working}
                    onClick={() =>
                      setDraft({
                        id: item.id,
                        slug: item.slug,
                        name: item.name,
                        description: item.description,
                        kind: item.kind,
                        enabled: item.enabled,
                        content: item.content
                      })
                    }
                  >
                    编辑
                  </button>
                  <button
                    className="button danger small"
                    disabled={working}
                    onClick={() => setPendingDelete(item)}
                  >
                    <Trash2 size={13} />
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={Boolean(draft)}
        onOpenChange={(open) => { if (!open && !working) setDraft(null); }}
        title={draft?.id ? '编辑覆写 / 脚本' : '新建覆写 / 脚本'}
        description="覆写内容校验为合法 YAML 映射；在 .stoverride 中写 {{BASE_URL}}/xxx.js 会自动替换为设备下载链接。"
        footer={
          <>
            <button className="button secondary" disabled={working} onClick={() => setDraft(null)}>取消</button>
            <button className="button primary" disabled={working} onClick={() => void saveDraft()}>
              {working ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {draft ? (
          <div className="form-grid">
            <label className="field">
              <span>名称</span>
              <input
                className="input"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="例如 仪表盘磁贴覆写"
              />
            </label>
            <label className="field">
              <span>文件标识（URL 后缀）</span>
              <input
                className="input mono"
                value={draft.slug}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                placeholder="例如 stash-tiles.stoverride"
              />
            </label>
            <SelectField
              label="类型"
              value={draft.kind}
              onValueChange={(value) => setDraft({ ...draft, kind: value as StashOverrideKind })}
              options={[
                { value: 'override', label: 'Stash 覆写（YAML / .stoverride）' },
                { value: 'script', label: 'JavaScript 脚本（.js）' }
              ]}
            />
            <div className="field">
              <SwitchField
                label="启用对外下载"
                checked={draft.enabled}
                onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
                description="停用后设备只读链接将返回 404。"
              />
            </div>
            <label className="field wide">
              <span>说明（可选）</span>
              <input
                className="input"
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <label className="field wide">
              <span>内容</span>
              <textarea
                className="code-input"
                rows={12}
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            </label>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => { if (!open && !working) setPendingDelete(null); }}
        title="删除覆写或脚本？"
        description={`确定删除「${pendingDelete?.name ?? ''}」（${pendingDelete?.slug ?? ''}）？删除后设备订阅该文件将返回 404。`}
        footer={
          <>
            <button className="button secondary" disabled={working} onClick={() => setPendingDelete(null)}>取消</button>
            <button className="button danger" disabled={working} onClick={() => void confirmDelete()}>确认删除</button>
          </>
        }
      >
        <p className="delivery-note">删除操作不会影响主配置 YAML。</p>
      </Modal>

      <Modal
        open={Boolean(pendingLinkAction)}
        onOpenChange={(open) => { if (!open && !working) setPendingLinkAction(null); }}
        title={pendingLinkAction === 'revoke' ? '撤销覆写订阅链接？' : tokenConfigured ? '更换覆写订阅链接？' : '生成覆写订阅链接？'}
        description={
          pendingLinkAction === 'revoke'
            ? '撤销后所有使用旧覆写链接的设备将无法继续拉取更新。'
            : tokenConfigured
              ? '更换后旧链接会立即失效，需要在 Stash 中更新覆写 URL。'
              : '将生成一个可撤销的只读令牌，用于在 Stash 中订阅托管的 .stoverride 与脚本。'
        }
        footer={
          <>
            <button className="button secondary" disabled={working} onClick={() => setPendingLinkAction(null)}>取消</button>
            <button
              className={pendingLinkAction === 'revoke' ? 'button danger' : 'button primary'}
              disabled={working}
              onClick={() => pendingLinkAction && void runLinkAction(pendingLinkAction)}
            >
              确认
            </button>
          </>
        }
      >
        <p className="delivery-note">此令牌独立于主配置订阅链接，不影响 Stash / Mihomo 主订阅。</p>
      </Modal>
    </section>
  );
}
