'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Box,
  Boxes,
  ChevronRight,
  Database,
  Clock3,
  Download,
  FileCode2,
  FileInput,
  Globe2,
  History,
  Layers3,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sparkles,
  Upload
} from 'lucide-react';

import type {
  HostEntry,
  JsonValue,
  Profile,
  ProxyGroup,
  ProxyNode,
  ProxyProvider,
  ResourceKind,
  RuleProvider,
  Snapshot,
  StashRule,
  ValidationResult
} from '@/lib/types';

import { AdvancedView } from './advanced-view';
import { ApiError, apiRequest } from './api-client';
import { EditorDialog } from './editor-dialog';
import { ExportView } from './export-view';
import { HistoryView } from './history-view';
import { OverviewView } from './overview-view';
import { ResourceList } from './resource-list';
import { RulesView } from './rules-view';
import { SettingsView } from './settings-view';
import { Modal, SelectField, StatusBadge } from './ui';
import { RelationshipsView, type EditorPreset } from './relationships-view';
import { resourceKey, type ResourceNode } from '@/lib/resource-graph';

type SectionId =
  | 'relationships'
  | 'overview'
  | 'settings'
  | 'proxy-providers'
  | 'proxies'
  | 'proxy-groups'
  | 'rule-providers'
  | 'rules'
  | 'hosts'
  | 'advanced'
  | 'export'
  | 'history';

type SnapshotResponse = Snapshot & { validation: ValidationResult };
type EditableResource =
  | ProxyNode
  | ProxyProvider
  | ProxyGroup
  | RuleProvider
  | StashRule
  | HostEntry
  | null;

interface Meta {
  rule_types: string[];
  rule_options: string[];
  proxy_group_types: string[];
  builtin_policies: string[];
  admin_token_required: boolean;
}

const NAV = [
  { id: 'overview', label: '总览', icon: Sparkles },
  { id: 'relationships', label: '关联关系', icon: Network },
  { id: 'settings', label: '全局与 DNS', icon: Settings2 },
  { id: 'proxy-providers', label: '代理源', icon: Database },
  { id: 'proxies', label: '直接节点', icon: Box },
  { id: 'proxy-groups', label: '策略组', icon: Layers3 },
  { id: 'rule-providers', label: '规则集', icon: Boxes },
  { id: 'rules', label: '路由规则', icon: Activity },
  { id: 'hosts', label: 'Hosts', icon: Globe2 },
  { id: 'advanced', label: '高级区块', icon: FileCode2 },
  { id: 'export', label: '下载配置', icon: Download },
  { id: 'history', label: '版本', icon: History }
] as const;

const SECTION_COPY: Partial<
  Record<SectionId, { title: string; subtitle: string; kind: ResourceKind }>
> = {
  'proxy-providers': {
    title: '代理源',
    subtitle:
      '管理远程节点订阅、缓存路径、倍率、测速和过滤参数；每个来源的私人地址和认证请求头独立加密保存。',
    kind: 'proxy-providers'
  },
  proxies: {
    title: '直接节点',
    subtitle:
      '声明 Shadowsocks、VMess、Trojan、Hysteria、WireGuard 等协议节点。协议字段以加密 JSON 保存。',
    kind: 'proxies'
  },
  'proxy-groups': {
    title: '策略组',
    subtitle:
      '维护 select、url-test、fallback、load-balance、relay，以及成员、代理源、filter 和延迟测试参数。',
    kind: 'proxy-groups'
  },
  'rule-providers': {
    title: '规则集',
    subtitle:
      '为每个规则集设置管理界面名称；Stash 标识仍用于 RULE-SET 引用和 YAML 导出。名称不会从规则内容自动推断。',
    kind: 'rule-providers'
  },
  hosts: {
    title: 'Host 映射',
    subtitle: '维护主机名或通配符到 IP/域名的静态映射。',
    kind: 'hosts'
  }
};

function resourcesFor(snapshot: Snapshot, kind: ResourceKind) {
  if (kind === 'proxy-providers') return snapshot.proxyProviders;
  if (kind === 'proxies') return snapshot.proxies;
  if (kind === 'proxy-groups') return snapshot.proxyGroups;
  if (kind === 'rule-providers') return snapshot.ruleProviders;
  if (kind === 'hosts') return snapshot.hosts;
  return snapshot.rules;
}

function resourceLabel(kind: ResourceKind, item: EditableResource): string {
  if (!item) return '';
  if ('name' in item) return item.name;
  if ('pattern' in item) return item.pattern;
  return item.type;
}

function readSessionToken(): string {
  try {
    return window.sessionStorage.getItem('stash-admin-token') || '';
  } catch {
    return '';
  }
}

function writeSessionToken(value: string): void {
  try {
    if (value) window.sessionStorage.setItem('stash-admin-token', value);
    else window.sessionStorage.removeItem('stash-admin-token');
  } catch {
    // The token still remains available in component state for this page view.
  }
}

export function ConfigStudio() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({
    valid: false,
    issues: []
  });
  const [section, setSection] = useState<SectionId>('overview');
  const [token, setToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const [editorPreset, setEditorPreset] = useState<EditorPreset | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorKind, setEditorKind] = useState<ResourceKind | null>(null);
  const [editing, setEditing] = useState<EditableResource>(null);
  const [profileDialog, setProfileDialog] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileSource, setNewProfileSource] = useState('empty');
  const [newProfileYaml, setNewProfileYaml] = useState('');
  const [importDialog, setImportDialog] = useState(false);
  const [importYamlText, setImportYamlText] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    tone: 'good' | 'bad' | 'warn';
  } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback(
    (message: string, tone: 'good' | 'bad' | 'warn' = 'good') => {
      setToast({ message, tone });
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 5200);
    },
    []
  );

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 401) {
        setAuthRequired(true);
        notify('管理员令牌无效或已失效。', 'bad');
        return;
      }
      notify(caught instanceof Error ? caught.message : '操作失败', 'bad');
    },
    [notify]
  );

  const loadProfiles = useCallback(
    async (usingToken: string, preferredId?: number | null) => {
      const data = await apiRequest<{ items: Profile[] }>('/api/profiles', {
        token: usingToken
      });
      setProfiles(data.items);
      const next =
        data.items.find((item) => item.id === preferredId) ||
        data.items.find((item) => item.active) ||
        data.items[0];
      if (!next) throw new Error('没有可用的配置 Profile');
      setProfileId(next.id);
      try {
        window.sessionStorage.setItem('stash-profile-id', String(next.id));
      } catch {
        /* Session storage may be unavailable. */
      }
      return next;
    },
    []
  );

  const loadSnapshot = useCallback(
    async (id: number, usingToken: string, quiet = false) => {
      if (!quiet) setLoading(true);
      else setRefreshing(true);
      try {
        const data = await apiRequest<SnapshotResponse>(
          `/api/profiles/${id}/snapshot`,
          { token: usingToken }
        );
        setSnapshot({
          profile: data.profile,
          proxies: data.proxies,
          proxyProviders: data.proxyProviders,
          proxyGroups: data.proxyGroups,
          ruleProviders: data.ruleProviders,
          rules: data.rules,
          hosts: data.hosts,
          advancedSections: data.advancedSections
        });
        setValidation(data.validation);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  const initialise = useCallback(
    async (usingToken: string, preferred?: number | null) => {
      setLoading(true);
      try {
        const metaData = await apiRequest<Meta>('/api/meta');
        setMeta(metaData);
        const profile = await loadProfiles(usingToken, preferred);
        await loadSnapshot(profile.id, usingToken);
        setAuthRequired(false);
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          setAuthRequired(true);
        } else {
          handleError(caught);
        }
      } finally {
        setLoading(false);
      }
    },
    [handleError, loadProfiles, loadSnapshot]
  );

  useEffect(() => {
    const saved = readSessionToken();
    setToken(saved);
    setTokenDraft(saved);
    let savedProfile: number | undefined;
    try {
      const value = Number(window.sessionStorage.getItem('stash-profile-id'));
      if (Number.isSafeInteger(value) && value > 0) savedProfile = value;
    } catch {
      /* Use active profile. */
    }
    void initialise(saved, savedProfile);
  }, [initialise]);

  async function unlock() {
    const value = tokenDraft.trim();
    setToken(value);
    writeSessionToken(value);
    await initialise(value, profileId);
  }

  async function reload(message?: string) {
    if (!profileId) return;
    try {
      await loadSnapshot(profileId, token, true);
      const nextProfiles = await apiRequest<{ items: Profile[] }>(
        '/api/profiles',
        {
          token
        }
      );
      setProfiles(nextProfiles.items);
      if (message) notify(message);
    } catch (caught) {
      handleError(caught);
    }
  }

  async function switchProfile(id: number) {
    setProfileId(id);
    try {
      window.sessionStorage.setItem('stash-profile-id', String(id));
    } catch {
      /* Session storage may be unavailable. */
    }
    setSection('overview');
    setGraphFocus(null);
    try {
      await loadSnapshot(id, token);
    } catch (caught) {
      handleError(caught);
    }
  }

  async function activateCurrent() {
    if (!profileId) return;
    try {
      await apiRequest(`/api/profiles/${profileId}`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ active: true })
      });
      await reload('当前 Profile 已设为活动配置。');
    } catch (caught) {
      handleError(caught);
    }
  }

  function openEditor(kind: ResourceKind, item: EditableResource = null) {
    setEditorPreset(undefined);
    setEditorKind(kind);
    setEditing(item);
    setEditorOpen(true);
  }

  async function deleteResource(kind: ResourceKind, item: EditableResource) {
    if (!item || !profileId) return;
    if (
      !window.confirm(
        `删除 ${resourceLabel(kind, item)}？引用保护会拒绝删除仍被使用的资源。`
      )
    ) {
      return;
    }
    try {
      await apiRequest(`/api/profiles/${profileId}/${kind}/${item.id}`, {
        method: 'DELETE',
        token
      });
      await reload('资源已删除。');
    } catch (caught) {
      handleError(caught);
    }
  }

  function inspectResource(kind: ResourceKind, item: { id: number }) {
    setGraphFocus(resourceKey(kind, item.id));
    setSection('relationships');
  }
  function editGraphResource(node: ResourceNode) {
    if (!snapshot) return;
    if (node.kind === 'settings') {
      setSection('settings');
      return;
    }
    if (node.kind === 'advanced') {
      setSection('advanced');
      return;
    }
    if (node.kind === 'builtin' || node.kind === 'missing') return;
    const kind = node.kind as ResourceKind;
    const item = resourcesFor(snapshot, kind).find(
      (entry) => entry.id === node.id
    );
    if (item) openEditor(kind, item as EditableResource);
  }
  function createRelated(kind: 'proxy-groups' | 'rules', preset: EditorPreset) {
    setEditorKind(kind);
    setEditing(null);
    setEditorPreset(preset);
    setEditorOpen(true);
  }

  async function createProfile() {
    setProfileBusy(true);
    try {
      const data = await apiRequest<SnapshotResponse>('/api/profiles', {
        method: 'POST',
        token,
        body: JSON.stringify({
          name: newProfileName.trim(),
          importYaml:
            newProfileSource === 'import'
              ? newProfileYaml.trim() || undefined
              : undefined,
          example: newProfileSource === 'example'
        })
      });
      setProfileDialog(false);
      setNewProfileName('');
      setNewProfileYaml('');
      setNewProfileSource('empty');
      setSection(newProfileSource === 'empty' ? 'overview' : 'relationships');
      await initialise(token, data.profile.id);
      notify('新配置已创建。');
    } catch (caught) {
      handleError(caught);
    } finally {
      setProfileBusy(false);
    }
  }

  async function importCurrent() {
    if (!profileId) return;
    setProfileBusy(true);
    try {
      await apiRequest(`/api/profiles/${profileId}/import`, {
        method: 'POST',
        token,
        body: JSON.stringify({ yaml: importYamlText })
      });
      setImportDialog(false);
      setImportYamlText('');
      await reload('配置文件已解析，可以从关联关系中继续配置。');
      setGraphFocus(null);
      setSection('relationships');
    } catch (caught) {
      handleError(caught);
    } finally {
      setProfileBusy(false);
    }
  }

  const currentProfile = profiles.find((item) => item.id === profileId);
  const profileOptions = profiles.map((profile) => ({
    value: String(profile.id),
    label: `${profile.active ? '● ' : ''}${profile.name}`
  }));
  const errorCount = validation.issues.filter(
    (issue) => issue.severity === 'error'
  ).length;

  if (authRequired) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="brand-lockup">
            <span>SF</span>
            <div>
              STASH
              <br />
              CONFIG FORGE
            </div>
          </div>
          <p className="kicker">ADMIN / AUTHENTICATION</p>
          <h1>进入配置控制台</h1>
          <p>服务端已启用 `STASH_ADMIN_TOKEN`。令牌只保存在当前浏览器会话。</p>
          <label className="field wide">
            <span>管理员令牌</span>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void unlock();
              }}
            />
          </label>
          <button className="button primary" onClick={unlock}>
            验证并连接
            <ChevronRight size={16} />
          </button>
          {toast ? <div className="auth-error">{toast.message}</div> : null}
        </div>
      </main>
    );
  }

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a className="brand-lockup" href="/">
          <span>SF</span>
          <div>
            STASH
            <br />
            CONFIG FORGE
          </div>
        </a>
        <div className="sidebar-status">
          <span className="live-dot" />
          <div>
            <strong>配置已保存</strong>
            <small>
              {currentProfile ? `REV ${currentProfile.revision}` : 'CONNECTING'}
            </small>
          </div>
        </div>
        <nav className="side-nav" aria-label="配置导航">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={section === item.id ? 'active' : ''}
                onClick={() => setSection(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <button onClick={() => void reload()}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
            刷新快照
          </button>
          <span>凭据已加密保存</span>
        </div>
      </aside>

      <main className="studio-main">
        <header className="topbar">
          <div className="profile-picker">
            <span>PROFILE</span>
            <SelectField
              value={profileId ? String(profileId) : ''}
              onValueChange={(value) => void switchProfile(Number(value))}
              options={profileOptions}
            />
            {currentProfile && !currentProfile.active ? (
              <button className="text-action" onClick={activateCurrent}>
                设为活动
              </button>
            ) : (
              <StatusBadge tone="good">ACTIVE</StatusBadge>
            )}
          </div>
          <div className="topbar-actions">
            <button
              className="button secondary small"
              onClick={() => setImportDialog(true)}
            >
              <FileInput size={15} />
              导入配置文件
            </button>
            <button
              className="button secondary small"
              onClick={() => setProfileDialog(true)}
            >
              <Plus size={15} />
              新建配置
            </button>
            <button
              className="button primary small"
              onClick={() => setSection('export')}
            >
              <Download size={15} />
              下载配置
            </button>
          </div>
        </header>

        <div className="mobile-nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={section === item.id ? 'active' : ''}
                onClick={() => setSection(item.id)}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </div>

        {loading || !snapshot || !meta ? (
          <div className="loading-screen">
            <div className="loading-mark">SF</div>
            <p>正在读取加密配置快照…</p>
          </div>
        ) : (
          <div className="content-stage">
            {section === 'overview' ? (
              <OverviewView
                token={token}
                snapshot={snapshot}
                validation={validation}
                onNavigate={(value) => setSection(value as SectionId)}
              />
            ) : null}

            {section === 'relationships' ? (
              <RelationshipsView
                snapshot={snapshot}
                focus={graphFocus}
                onFocus={setGraphFocus}
                onEdit={editGraphResource}
                onCreate={createRelated}
              />
            ) : null}
            {section === 'settings' ? (
              <SettingsView
                snapshot={snapshot}
                profileId={snapshot.profile.id}
                token={token}
                onSaved={reload}
              />
            ) : null}

            {section === 'proxies' ||
            section === 'proxy-providers' ||
            section === 'proxy-groups' ||
            section === 'rule-providers' ||
            section === 'hosts' ? (
              <ResourceList
                kind={SECTION_COPY[section]!.kind}
                title={SECTION_COPY[section]!.title}
                subtitle={SECTION_COPY[section]!.subtitle}
                items={
                  resourcesFor(snapshot, SECTION_COPY[section]!.kind) as Array<
                    | ProxyNode
                    | ProxyProvider
                    | ProxyGroup
                    | RuleProvider
                    | HostEntry
                  >
                }
                onInspect={(item) =>
                  inspectResource(SECTION_COPY[section]!.kind, item)
                }
                onAdd={() => openEditor(SECTION_COPY[section]!.kind)}
                onEdit={(item) =>
                  openEditor(
                    SECTION_COPY[section]!.kind,
                    item as EditableResource
                  )
                }
                onDelete={(item) =>
                  deleteResource(
                    SECTION_COPY[section]!.kind,
                    item as EditableResource
                  )
                }
              />
            ) : null}

            {section === 'rules' ? (
              <RulesView
                snapshot={snapshot}
                validation={validation}
                profileId={snapshot.profile.id}
                token={token}
                onInspect={(rule) => inspectResource('rules', rule)}
                onAdd={() => openEditor('rules')}
                onEdit={(rule) => openEditor('rules', rule)}
                onChanged={reload}
              />
            ) : null}

            {section === 'advanced' ? (
              <AdvancedView
                snapshot={snapshot}
                profileId={snapshot.profile.id}
                token={token}
                onSaved={reload}
              />
            ) : null}

            {section === 'export' ? (
              <ExportView
                snapshot={snapshot}
                validation={validation}
                profileId={snapshot.profile.id}
                token={token}
              />
            ) : null}

            {section === 'history' ? (
              <HistoryView
                profileId={snapshot.profile.id}
                token={token}
                currentRevision={snapshot.profile.revision}
                onRestored={reload}
              />
            ) : null}
          </div>
        )}

        <footer className="studio-footer">
          <span>
            <Clock3 size={13} />
            配置状态 {errorCount ? '待修复' : '检查通过'} ·{' '}
            {validation.issues.length} 项检查结果
          </span>
          <span>来源凭据加密保存 · 保存后自动检查</span>
        </footer>
      </main>

      {editorKind ? (
        <EditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          initialValues={editorPreset}
          resource={editorKind}
          existing={editing}
          snapshot={snapshot!}
          profileId={snapshot!.profile.id}
          token={token}
          onSaved={reload}
        />
      ) : null}

      <Modal
        open={profileDialog}
        onOpenChange={setProfileDialog}
        title="新建配置"
        description="可以从空配置开始，或直接导入完整 Stash YAML。"
        wide
        footer={
          <>
            <button
              className="button secondary"
              onClick={() => setProfileDialog(false)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={profileBusy || !newProfileName.trim()}
              onClick={createProfile}
            >
              {profileBusy ? '创建中…' : '创建配置'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <label className="field wide">
            <span>配置名称</span>
            <input
              className="input"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
              placeholder="例如：我的手机"
            />
          </label>
          <SelectField
            label="从哪里开始"
            value={newProfileSource}
            onValueChange={setNewProfileSource}
            options={[
              { value: 'empty', label: '最小配置 · 自己添加需要的资源' },
              { value: 'import', label: '导入已有 YAML' },
              { value: 'example', label: '可选示例 · 用于了解各项功能' }
            ]}
            wide
          />
          {newProfileSource === 'import' ? (
            <>
              <label className="field wide">
                <span>完整 YAML</span>
                <textarea
                  className="code-input"
                  rows={13}
                  value={newProfileYaml}
                  onChange={(event) => setNewProfileYaml(event.target.value)}
                  placeholder="留空则创建最小 Profile"
                />
              </label>
              <label className="file-drop wide">
                <Upload size={18} />
                <span>选择 YAML 文件</span>
                <input
                  type="file"
                  accept=".yaml,.yml,.conf,.config,text/yaml,application/yaml,text/plain,application/json"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) setNewProfileYaml(await file.text());
                  }}
                />
              </label>
            </>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={importDialog}
        onOpenChange={setImportDialog}
        title="导入并替换当前 Profile"
        description="导入内容会转换为结构化资源，并自动生成恢复前版本快照。"
        wide
        footer={
          <>
            <button
              className="button secondary"
              onClick={() => setImportDialog(false)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={profileBusy || !importYamlText.trim()}
              onClick={importCurrent}
            >
              {profileBusy ? '导入中…' : '导入完整 YAML'}
            </button>
          </>
        }
      >
        <label className="file-drop">
          <Upload size={18} />
          <span>读取 YAML 文件</span>
          <input
            type="file"
            accept=".yaml,.yml,.conf,.config,text/yaml,application/yaml,text/plain,application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setImportYamlText(await file.text());
            }}
          />
        </label>
        <textarea
          className="code-input import-code"
          rows={18}
          value={importYamlText}
          onChange={(event) => setImportYamlText(event.target.value)}
          placeholder="粘贴完整 Stash YAML"
        />
      </Modal>

      {toast ? (
        <div className={`toast toast-${toast.tone}`}>
          {toast.tone === 'bad' ? (
            <ShieldAlert size={17} />
          ) : (
            <Sparkles size={17} />
          )}
          <span>{toast.message}</span>
        </div>
      ) : null}
    </div>
  );
}
