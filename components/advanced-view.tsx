'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { JsonValue, Snapshot } from '@/lib/types';
import { ApiError, apiRequest } from './api-client';
import { ConfigFields } from './config-fields';
import { useUnsavedChanges } from './unsaved-changes';

interface DraftSection {
  id: string;
  key: string;
  text: string;
}
const PRESETS = [
  {
    key: 'http',
    label: 'HTTP 处理',
    description:
      '配置需要处理的主机、重写和脚本规则。HTTPS 解密的证书信任需在设备中设置。',
    fields: { mitm: [], 'force-http-engine': [], 'url-rewrite': [], script: [] }
  },
  {
    key: 'cron',
    label: '定时任务',
    description: '配置任务名称、执行时间与参数；脚本需要在脚本来源中定义。',
    fields: { script: [] }
  },
  {
    key: 'script-providers',
    label: '脚本来源',
    description:
      '按脚本标识定义下载地址和更新间隔。可以添加自定义名称的字段组。',
    fields: {}
  },
  {
    key: 'script',
    label: '脚本条件',
    description: '维护路由规则引用的脚本快捷条件。',
    fields: { shortcuts: {} }
  },
  {
    key: 'mtproto',
    label: 'MTProto 服务',
    description: '维护该顶层区块的设备服务参数。',
    fields: {}
  },
  {
    key: 'stashlink',
    label: 'StashLink',
    description: '维护该顶层区块的设备互联参数。',
    fields: {}
  }
] as Array<{
  key: string;
  label: string;
  description: string;
  fields: Record<string, JsonValue>;
}>;
export function AdvancedView({
  snapshot,
  profileId,
  token,
  onSaved
}: {
  snapshot: Snapshot;
  profileId: number;
  token: string;
  onSaved: (message: string) => Promise<void>;
}) {
  const [sections, setSections] = useState<DraftSection[]>([]),
    [customKey, setCustomKey] = useState('');
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [draftRevision, setDraftRevision] = useState(snapshot.profile.revision);
  const root = useRef<HTMLElement>(null);
  const [baseline, setBaseline] = useState('[]');
  const fingerprint = JSON.stringify(sections.map(({ key, text }) => ({ key, text })));
  const dirty = fingerprint !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const loadedProfile = useRef(profileId);
  const { confirmDiscard } = useUnsavedChanges(dirty, saving, resetDraft);
  function resetDraft() {
    setDraftRevision(snapshot.profile.revision);
    setConflict(false);
    dirtyRef.current = false;
    loadedProfile.current = profileId;
    const next = snapshot.advancedSections.map((section) => ({
      id: String(section.id),
      key: section.key,
      text: JSON.stringify(section.value, null, 2)
    }));
    setSections(next);
    setBaseline(JSON.stringify(next.map(({ key, text }) => ({ key, text }))));
    setCustomKey('');
    setError('');
  }
  useEffect(() => {
    if (loadedProfile.current === profileId && dirtyRef.current) return;
    resetDraft();
  }, [snapshot, profileId]);
  function add(key: string) {
    key = key.trim();
    if (!key || sections.some((s) => s.key === key)) {
      setError('请输入尚未存在的区块名称。');
      return;
    }
    setSections((current) => [
      ...current,
      { id: crypto.randomUUID(), key, text: '{}' }
    ]);
    setCustomKey('');
    setError('');
  }
  function update(index: number, patch: Partial<DraftSection>) {
    setSections((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );
  }
  async function save() {
    if (saving) return;
    const invalid =
      root.current?.querySelector<HTMLInputElement>('input:invalid');
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const parsed = sections.map((s) => {
        if (!s.key.trim()) throw new Error('区块名称不能为空');
        let value: JsonValue;
        try {
          value = JSON.parse(s.text);
        } catch {
          throw new Error(`区块 ${s.key} 的源码格式不正确，请在专家模式修复。`);
        }
        return { key: s.key.trim(), value };
      });
      await apiRequest(`/api/profiles/${profileId}/advanced`, {
        method: 'PUT',
        expectedRevision: draftRevision,
        token,
        body: JSON.stringify({ sections: parsed })
      });
      dirtyRef.current = false;
      setBaseline(fingerprint);
      await onSaved('扩展配置已保存并检查。');
    } catch (caught) {
      setConflict(caught instanceof ApiError && caught.code === 'revision.conflict');
      setError(
        caught instanceof ApiError && caught.issues.length
          ? caught.issues.map((i) => i.message).join('\n')
          : caught instanceof Error
            ? caught.message
            : '保存失败'
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel" ref={root} inert={saving} aria-busy={saving}>
      <div className="panel-heading">
        <div>
          <p className="kicker">扩展配置</p>
          <h2>按字段调整扩展功能</h2>
          <p>
            原文件中的区块会自动展开为字段表单。列表可添加、删除和调整顺序，开关和数字保持原类型；需要直接编辑源码时再切换专家模式。
          </p>
        </div>
        <button
          className="button primary"
          onClick={() => void save()}
          disabled={saving}
        >
          <Save size={16} />
          {saving ? '保存中…' : '保存扩展配置'}
        </button>
      </div>
      {conflict ? <div className="inline-error" role="alert"><p>其他会话已更新配置，本页输入仍保留。</p><button className="button secondary" onClick={() => {
        void (async () => { if (await confirmDiscard()) void onSaved('已重新读取配置，请检查最新内容。'); })();
      }}>放弃本页修改并读取最新配置</button></div> : null}
      {dirty ? <p className="delivery-note" role="status">有未保存的修改，保存后才会检查并更新配置。</p> : null}
      <div className="preset-row">
        {PRESETS.filter((p) => !sections.some((s) => s.key === p.key)).map(
          (p) => (
            <button
              className="preset-chip"
              key={p.key}
              onClick={() => add(p.key)}
            >
              <Plus size={13} />
              {p.label}
            </button>
          )
        )}
      </div>
      <details>
        <summary>添加原文件以外的自定义顶层区块</summary>
        <div className="value-add">
          <input
            className="input"
            aria-label="自定义区块名称"
            value={customKey}
            onChange={(e) => setCustomKey(e.target.value)}
            placeholder="Stash 顶层字段名"
          />
          <button className="button secondary" onClick={() => add(customKey)}>
            添加区块
          </button>
        </div>
        <p className="delivery-note">
          自定义字段会按输入结构保存；兼容性取决于目标 Stash 版本。
        </p>
      </details>
      <div className="advanced-stack">
        {sections.map((section, index) => {
          const metadata = PRESETS.find((p) => p.key === section.key);
          return (
            <article className="advanced-card" key={section.id}>
              <header>
                <div>
                  <h3>{metadata?.label || section.key}</h3>
                  <p className="delivery-note">
                    {metadata?.description ||
                      '来自原文件的扩展字段，保留原结构并按需编辑。'}
                  </p>
                </div>
                <button
                  className="icon-button danger"
                  aria-label={`删除区块 ${section.key}`}
                  onClick={() =>
                    setSections((current) =>
                      current.filter((s) => s.id !== section.id)
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </header>
              <details>
                <summary>区块标识：{section.key}</summary>
                <label className="field">
                  <span>Stash 顶层字段名</span>
                  <input
                    className="input"
                    value={section.key}
                    onChange={(e) => update(index, { key: e.target.value })}
                  />
                </label>
              </details>
              <ConfigFields
                label={metadata?.label || section.key}
                text={section.text}
                onChange={(text) => update(index, { text })}
                objectOnly={false}
                suggestions={metadata?.fields}
              />
            </article>
          );
        })}
        {sections.length === 0 ? (
          <div className="empty-state">
            <strong>当前配置没有额外区块</strong>
            <span>只需添加自己会使用的功能。</span>
          </div>
        ) : null}
      </div>
      {error ? (
        <pre className="inline-error" role="alert">
          {error}
        </pre>
      ) : null}
    </section>
  );
}
