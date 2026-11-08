'use client';

import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type { Snapshot } from '@/lib/types';
import { apiRequest } from './api-client';
import { ImportPreview } from './import-preview';
import { InspectNewImport } from './import-classification';
import { Modal, SelectField } from './ui';
import { useUnsavedChanges } from './unsaved-changes';

export type ImportDialogMode = 'new' | 'replace' | null;

export function ProfileImportDialogs({ mode, setMode, profile, token, onBusy, onCreated, onReplaced, onError }: {
  mode: ImportDialogMode;
  setMode: (mode: ImportDialogMode) => void;
  profile?: Snapshot['profile'];
  token: string;
  onBusy: (busy: boolean) => void;
  onCreated: (id: number, hasResources: boolean) => Promise<void>;
  onReplaced: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('empty');
  const [content, setContent] = useState('');
  const [inspectedContent, setInspectedContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ text: string; revision: number; fingerprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const fileRead = useRef(0);
  function reset() {
    fileRead.current++;
    setName(''); setSource('empty'); setContent(''); setInspectedContent(null); setPreview(null);
  }
  const { confirmDiscard } = useUnsavedChanges(Boolean(mode && (name || content || source !== 'empty')), busy, reset);
  async function close(open: boolean) {
    if (!open && !busy && await confirmDiscard()) {
      reset();
      setMode(null);
    }
  }
  function changeContent(text: string) {
    fileRead.current++;
    setPreview(null);
    setInspectedContent(null);
    setContent(text);
  }
  function switchMode(next: ImportDialogMode) {
    fileRead.current++;
    setPreview(null);
    setInspectedContent(null);
    if (next === 'new') setSource('import');
    setMode(next);
  }
  const canCreate = Boolean(name.trim() && (source !== 'import' || (content.trim() && inspectedContent === content)));
  const canReplace = Boolean(profile && content.trim() && preview?.text === content);
  async function submit() {
    if (!mode || lock.current || (mode === 'new' ? !canCreate : !canReplace)) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    try {
      if (mode === 'new') {
        const created = await apiRequest<Snapshot>('/api/profiles', {
          method: 'POST', token, body: JSON.stringify({
            name: name.trim(), importYaml: source === 'import' ? content : undefined, example: source === 'example'
          })
        });
        setMode(null);
        reset();
        await onCreated(created.profile.id, source !== 'empty');
      } else {
        await apiRequest(`/api/profiles/${profile!.id}/import`, {
          method: 'POST', token, expectedRevision: preview!.revision, body: JSON.stringify({ yaml: content, previewFingerprint: preview!.fingerprint })
        });
        setMode(null);
        reset();
        await onReplaced();
      }
    } catch (error) { onError(error); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }

  const fileInput = (label: string) => <label className="file-drop wide">
    <Upload size={18} /><span>{label}</span>
    <input type="file" disabled={busy} accept=".yaml,.yml,.conf,.config,text/yaml,application/yaml,text/plain,application/json"
      onChange={async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reading = ++fileRead.current;
        setPreview(null);
        setInspectedContent(null);
        try {
          const text = await file.text();
          if (reading === fileRead.current) changeContent(text);
        } catch (error) { if (reading === fileRead.current) onError(error); }
      }} />
  </label>;

  const footer = (create: boolean) => <>
    <button className="button secondary" disabled={busy} onClick={() => void close(false)}>取消</button>
    <button className="button primary" disabled={busy || !(create ? canCreate : canReplace)} onClick={() => void submit()}>
      {create ? busy ? '创建中…' : '创建配置' : busy ? '导入中…' : '导入完整配置'}
    </button>
  </>;

  return <>
    <Modal open={mode === 'new'} onOpenChange={close} title="新建配置"
      description="可以从空配置开始，或导入 Stash YAML / Shadowrocket .conf。" wide footer={footer(true)}>
      <div className="form-grid" inert={busy}>
        <label className="field wide"><span>配置名称</span>
          <input className="input" value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的手机" />
        </label>
        <SelectField label="从哪里开始" value={source} onValueChange={setSource} wide options={[
          { value: 'empty', label: '最小配置 · 自己添加需要的资源' },
          { value: 'import', label: '导入已有配置' },
          { value: 'example', label: '可选示例 · 用于了解各项功能' }
        ]} />
        {source === 'import' ? <>
          <p className="delivery-note wide">创建独立配置。<button className="text-action" onClick={() => switchMode('replace')} disabled={!profile}>改为替换当前配置</button></p>
          {fileInput('选择配置文件')}
          <label className="field wide"><span>完整配置</span>
            <textarea className="code-input" rows={11} value={content} onChange={event => changeContent(event.target.value)} placeholder="粘贴 Stash YAML 或 Shadowrocket .conf" />
          </label>
          <InspectNewImport content={content} token={token} onReady={setInspectedContent} />
        </> : null}
      </div>
    </Modal>
    <Modal open={mode === 'replace'} onOpenChange={close} title="导入并替换当前 Profile"
      description={`将替换「${profile?.name || '当前配置'}」的全部资源。当前状态保留在版本历史，导入错误不会覆盖现有内容。`} wide footer={footer(false)}>
      <div className="form-grid" inert={busy}>
        <div className="delivery-actions wide" aria-label="导入目标">
          <span className="status-badge tone-warn">替换当前配置</span>
          <button className="button secondary small" onClick={() => switchMode('new')}>导入为新配置</button>
        </div>
        {fileInput('读取配置文件')}
        <textarea className="code-input import-code wide" aria-label="完整配置" rows={12} value={content}
          onChange={event => changeContent(event.target.value)} placeholder="粘贴 Stash YAML 或 Shadowrocket .conf" />
        {profile && <ImportPreview profileId={profile.id} token={token} yaml={content}
          onPreview={result => setPreview(result === null ? null : { text: content, revision: result.currentRevision, fingerprint: result.previewFingerprint })} />}
      </div>
    </Modal>
  </>;
}
