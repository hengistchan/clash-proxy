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
  Sparkles
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
  ValidationResult,
  ValidationIssue
} from '@/lib/types';

import { AdvancedView } from './advanced-view';
import { ApiError, apiRequest } from './api-client';
import { useResourceEditor, type EditableResource } from './use-resource-editor';
import { EditorDialog } from './editor-dialog';
import { useDeliveryWorkspace } from './use-delivery-workspace';
import type { ConfigTarget } from '@/lib/config-targets';
import { ExportView } from './export-view';
import { HistoryView } from './history-view';
import { ProfileImportDialogs, type ImportDialogMode } from './profile-import-dialogs';
import { OverviewView } from './overview-view';
import { ResourceList } from './resource-list';
import { RulesView } from './rules-view';
import { SettingsView } from './settings-view';
import { Modal, SelectField, StatusBadge } from './ui';
import { RelationshipsView, type EditorPreset } from './relationships-view';
import { resourceKey, type ResourceNode } from '@/lib/resource-graph';
import { UnsavedChangesProvider, useNavigationGuard } from './unsaved-changes';

type SectionId = 'relationships' | 'overview' | 'settings' | 'proxy-providers' | 'proxies' |
  'proxy-groups' | 'rule-providers' | 'rules' | 'hosts' | 'advanced' | 'export' | 'history';
type SnapshotResponse = Snapshot & { validation: ValidationResult };

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
      '管理 Shadowsocks、VMess、Trojan、Hysteria、WireGuard 等节点，按协议填写连接参数。',
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

function readSessionProfile(): number | undefined {
  try {
    const value = Number(window.sessionStorage.getItem('stash-profile-id'));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
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
  return <UnsavedChangesProvider><Workspace /></UnsavedChangesProvider>;
}

function Workspace() {
  const { confirmNavigation } = useNavigationGuard();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({
    valid: false,
    issues: []
  });
  const [section, setSection] = useState<SectionId>('overview');
  const [mobileResources, setMobileResources] = useState(false);
  const resourceNavActive = !['overview', 'rules', 'export', 'history'].includes(section);
  const [token, setToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const snapshotRequest = useRef(0);
  const initialiseRequest = useRef(0);
  const mutationLock = useRef(false);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const editor = useResourceEditor();
  const [importMode, setImportMode] = useState<ImportDialogMode>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    kind: ResourceKind;
    item: EditableResource;
  } | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    tone: 'good' | 'bad' | 'warn';
  } | null>(null);
  const toastTimer = useRef<number | null>(null);
  async function navigate(next: SectionId) {
    if (next === section || !(await confirmNavigation())) return;
    setSection(next);
  }

  async function openImportDialog() {
    if (await confirmNavigation()) setImportMode('replace');
  }

  async function openProfileDialog() {
    if (await confirmNavigation()) setImportMode('new');
  }

  async function inspectGraphNode(node: ResourceNode) {
    if (!(await confirmNavigation())) return;
    setGraphFocus(node.key);
    setSection('relationships');
  }

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
      const next =
        data.items.find((item) => item.id === preferredId) ||
        data.items.find((item) => item.active) ||
        data.items[0];
      if (!next) throw new Error('没有可用的配置 Profile');
      return { profile: next, items: data.items };
    },
    []
  );

  const loadSnapshot = useCallback(
    async (id: number, usingToken: string, quiet = false) => {
      const requestId = ++snapshotRequest.current;
      setConnectionError('');
      if (!quiet) setLoading(true);
      else setRefreshing(true);
      try {
        const data = await apiRequest<SnapshotResponse>(
          `/api/profiles/${id}/snapshot`,
          { token: usingToken }
        );
        if (requestId !== snapshotRequest.current) return false;
        setProfileId(data.profile.id);
        try {
          window.sessionStorage.setItem('stash-profile-id', String(data.profile.id));
        } catch { /* Session storage may be unavailable. */ }
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
        return true;
      } catch (caught) {
        if (requestId !== snapshotRequest.current) return false;
        setConnectionError(caught instanceof Error ? caught.message : '读取配置失败');
        throw caught;
      } finally {
        if (requestId === snapshotRequest.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    []
  );

  const initialise = useCallback(
    async (usingToken: string, preferred?: number | null) => {
      const requestId = ++initialiseRequest.current;
      setLoading(true);
      setConnectionError('');
      try {
        const metaData = await apiRequest<Meta>('/api/meta');
        if (requestId !== initialiseRequest.current) return;
        const data = await loadProfiles(usingToken, preferred);
        if (requestId !== initialiseRequest.current) return;
        setMeta(metaData);
        setProfiles(data.items);
        if (await loadSnapshot(data.profile.id, usingToken)) setAuthRequired(false);
      } catch (caught) {
        if (requestId !== initialiseRequest.current) return;
        if (caught instanceof ApiError && caught.status === 401) {
          setAuthRequired(true);
          if (usingToken) notify('管理员令牌无效或已失效。', 'bad');
        } else {
          setConnectionError(caught instanceof Error ? caught.message : '连接服务失败');
          handleError(caught);
        }
      } finally {
        if (requestId === initialiseRequest.current) setLoading(false);
      }
    },
    [handleError, loadProfiles, loadSnapshot, notify]
  );

  useEffect(() => {
    const saved = readSessionToken();
    setToken(saved);
    setTokenDraft(saved);
    void initialise(saved, readSessionProfile());
    return () => { initialiseRequest.current++; snapshotRequest.current++; if (toastTimer.current) window.clearTimeout(toastTimer.current); };
  }, [initialise]);

  async function unlock() {
    const value = tokenDraft.trim();
    setToken(value);
    writeSessionToken(value);
    await initialise(value, profileId ?? readSessionProfile());
  }

  async function reload(message?: string) {
    if (!profileId) return;
    try {
      if (!(await loadSnapshot(profileId, token, true))) return;
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
    if (id === profileId || !(await confirmNavigation())) return;
    initialiseRequest.current++;
    try {
      if (await loadSnapshot(id, token)) {
        setSection('overview');
        setGraphFocus(null);
        editor.close();
      }
    } catch (caught) {
      handleError(caught);
    }
  }

  async function refreshWorkspace() {
    if (!(await confirmNavigation())) return;
    if (snapshot && meta) void reload();
    else void initialise(token, profileId);
  }

  async function activateCurrent() {
    if (!profileId || mutationLock.current) return;
    mutationLock.current = true;
    setProfileBusy(true);
    try {
      await apiRequest(`/api/profiles/${profileId}`, {
        method: 'PUT',
        expectedRevision: snapshot!.profile.revision,
        token,
        body: JSON.stringify({ active: true })
      });
      await reload('当前 Profile 已设为活动配置。');
    } catch (caught) {
      handleError(caught);
    } finally { mutationLock.current = false; setProfileBusy(false); }
  }

  const openEditor = editor.open;

  function requestDelete(kind: ResourceKind, item: EditableResource) {
    if (!item || !profileId) return;
    if (mutationLock.current) {
      notify('正在处理上一个操作，请稍候再删除。', 'warn');
      return;
    }
    setPendingDelete({ kind, item });
  }

  async function confirmDelete() {
    if (!pendingDelete || !profileId || mutationLock.current) return;
    const { kind, item } = pendingDelete;
    mutationLock.current = true;
    setProfileBusy(true);
    try {
      await apiRequest(`/api/profiles/${profileId}/${kind}/${item!.id}`, {
        method: 'DELETE',
        expectedRevision: snapshot!.profile.revision,
        token
      });
      setPendingDelete(null);
      await reload('资源已删除。');
    } catch (caught) {
      setPendingDelete(null);
      handleError(caught);
    } finally { mutationLock.current = false; setProfileBusy(false); }
  }

  async function inspectResource(kind: ResourceKind, item: { id: number }) {
    if (!(await confirmNavigation())) return;
    setGraphFocus(resourceKey(kind, item.id));
    setSection('relationships');
  }
  async function editGraphResource(node: ResourceNode) {
    if (!snapshot) return;
    if (node.kind === 'settings') {
      await navigate('settings');
      return;
    }
    if (node.kind === 'advanced') {
      await navigate('advanced');
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
    editor.open(kind, null, preset);
  }

  async function fixIssue(issue: ValidationIssue) {
    if (!snapshot || !(await confirmNavigation())) return;
    const kind = ({
      'proxy-provider': 'proxy-providers', 'proxy-group': 'proxy-groups',
      'rule-provider': 'rule-providers', rule: 'rules', proxy: 'proxies', host: 'hosts'
    } as Record<string, ResourceKind>)[issue.resource || ''];
    if (kind && issue.resourceId) {
      const item = resourcesFor(snapshot, kind).find((entry) => entry.id === issue.resourceId);
      if (item) { openEditor(kind, item); return; }
    }
    setSection(kind || (issue.resource === 'advanced' ? 'advanced' : 'settings'));
  }

  const delivery = useDeliveryWorkspace(snapshot?.profile.id, snapshot?.profile.revision, token, section);
  async function openDelivery(target: ConfigTarget) {
    if (!(await confirmNavigation())) return;
    delivery.setTarget(target);
    setSection('export');
  }

  const currentProfile = snapshot?.profile.id === profileId ? snapshot.profile : profiles.find((item) => item.id === profileId);
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
          <p>输入管理员令牌以连接服务。令牌只保存在当前浏览器会话。</p>
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
          <button className="button primary" onClick={unlock} disabled={loading}>
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
            <strong>{loading ? '正在连接' : connectionError ? '连接待恢复' : errorCount ? '草稿待修复' : '配置已保存'}</strong>
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
                onClick={() => navigate(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <button onClick={refreshWorkspace} disabled={loading || refreshing}>
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
              disabled={loading || refreshing || profileBusy}
              onValueChange={(value) => void switchProfile(Number(value))}
              options={profileOptions}
            />
            {currentProfile && !currentProfile.active ? (
              <button className="text-action" onClick={activateCurrent} disabled={profileBusy || loading}>
                设为活动
              </button>
            ) : (
              <StatusBadge tone="good">ACTIVE</StatusBadge>
            )}
          </div>
          <div className="topbar-actions">
            <button
              className="button secondary small"
              disabled={loading || !snapshot}
              onClick={() => void openImportDialog()}
            >
              <FileInput size={15} />
              导入配置文件
            </button>
            <button
              className="button secondary small"
              onClick={() => void openProfileDialog()}
            >
              <Plus size={15} />
              新建配置
            </button>
            <button
              className="button primary small"
              onClick={() => navigate('export')}
            >
              <Download size={15} />
              下载配置
            </button>
          </div>
        </header>

        <nav className="mobile-nav" aria-label="手机配置导航">
          {([
            ['overview', '总览', '总览'], ['rules', '路由', '路由规则'],
            ['resources', '资源', '资源'], ['export', '交付', '交付'], ['history', '历史', '历史']
          ] as const).map(([id, label, aria]) => id === 'resources' ? (
            <button key={id} className={resourceNavActive ? 'active' : ''} aria-label={aria}
              aria-expanded={mobileResources} aria-controls="mobile-resource-nav"
              onClick={() => setMobileResources(open => !open)}>{label}</button>
          ) : (
            <button key={id} className={section === id ? 'active' : ''} aria-label={aria}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => { setMobileResources(false); void navigate(id); }}>{label}</button>
          ))}
          {mobileResources ? <div className="mobile-resource-nav" id="mobile-resource-nav">
            {NAV.filter(item => !['overview', 'rules', 'export', 'history'].includes(item.id)).map(item => (
              <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => {
                setMobileResources(false); void navigate(item.id);
              }}>{item.label}</button>
            ))}
          </div> : null}
        </nav>

        {connectionError ? (
          <div className="connection-banner" role="alert">
            <div><strong>无法更新配置</strong><p>{connectionError}</p></div>
            <button className="button secondary small" onClick={refreshWorkspace} disabled={loading || refreshing}>重新连接</button>
          </div>
        ) : null}
        {loading || (!connectionError && (!snapshot || !meta)) ? (
          <div className="loading-screen">
            <div className="loading-mark">SF</div>
            <p>正在读取加密配置快照…</p>
          </div>
        ) : snapshot && meta ? (
          <div className="content-stage" key={snapshot.profile.id}>
            {section === 'overview' ? (
              <OverviewView
                delivery={delivery}
                onDelivery={(target) => void openDelivery(target)}
                snapshot={snapshot}
                validation={validation}
                onNavigate={(value) => navigate(value as SectionId)}
                onFixIssue={fixIssue}
                onImport={() => void openImportDialog()}
                onInspect={(node) => void inspectGraphNode(node)}
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
                  requestDelete(
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
                delivery={delivery}
                profileId={snapshot.profile.id}
                token={token}
                onFixIssue={fixIssue}
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
        ) : null}

        <footer className="studio-footer">
          <span>
            <Clock3 size={13} />
            配置状态 {errorCount ? '待修复' : '检查通过'} ·{' '}
            {validation.issues.length} 项检查结果
          </span>
          <span>来源凭据加密保存 · 保存后自动检查</span>
        </footer>
      </main>

      {editor.session && snapshot ? (
        <EditorDialog
          open
          onOpenChange={open => { if (!open) editor.close(); }}
          initialValues={editor.session.preset}
          resource={editor.session.kind}
          existing={editor.session.item}
          snapshot={snapshot}
          profileId={snapshot.profile.id}
          token={token}
          onSaved={reload}
        />
      ) : null}

      <ProfileImportDialogs mode={importMode} setMode={setImportMode} profile={snapshot?.profile} token={token}
        onBusy={setProfileBusy} onError={handleError}
        onCreated={async (id, hasResources) => {
          setSection(hasResources ? 'relationships' : 'overview');
          await initialise(token, id);
          notify('新配置已创建。');
        }}
        onReplaced={async () => {
          await reload('配置文件已解析，可以从关联关系中继续配置。');
          setGraphFocus(null);
          setSection('relationships');
        }} />

      <Modal
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !profileBusy) setPendingDelete(null);
        }}
        title={
          pendingDelete
            ? `删除「${resourceLabel(pendingDelete.kind, pendingDelete.item)}」？`
            : '确认删除'
        }
        description="删除会生成一个新的配置修订；仍被规则、策略组或高级区块引用的资源会被拒绝删除。"
        footer={
          <>
            <button
              className="button secondary"
              onClick={() => setPendingDelete(null)}
              disabled={profileBusy}
            >
              取消
            </button>
            <button
              className="button danger"
              onClick={confirmDelete}
              disabled={profileBusy}
            >
              {profileBusy ? '删除中…' : '删除'}
            </button>
          </>
        }
      >
        <p className="delivery-note">
          资源一旦删除，只能从版本历史中恢复。请确认它不再被其他资源引用。
        </p>
      </Modal>

      {toast ? (
        <div className={`toast toast-${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'}>
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
