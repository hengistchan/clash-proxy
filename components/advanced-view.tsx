'use client';

import { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';

import type { JsonValue, Snapshot } from '@/lib/types';

import { ApiError, apiRequest } from './api-client';

interface DraftSection {
  key: string;
  text: string;
  original: JsonValue;
}

const PRESETS = ['http', 'cron', 'script-providers', 'script', 'mtproto', 'stashlink'];

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
  const [sections, setSections] = useState<DraftSection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSections(
      snapshot.advancedSections.map((section) => ({
        key: section.key,
        text: JSON.stringify(section.value, null, 2),
        original: section.value
      }))
    );
  }, [snapshot]);

  function updateSection(index: number, patch: Partial<DraftSection>) {
    setSections((current) =>
      current.map((section, itemIndex) =>
        itemIndex === index ? { ...section, ...patch } : section
      )
    );
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const parsed = sections.map((section) => {
        if (!section.key.trim()) throw new Error('高级区块名称不能为空');
        let value: JsonValue;
        try {
          value = JSON.parse(section.text || 'null') as JsonValue;
        } catch {
          throw new Error(`区块 ${section.key} 不是合法 JSON`);
        }
        return { key: section.key.trim(), value };
      });
      await apiRequest(`/api/profiles/${profileId}/advanced`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ sections: parsed })
      });
      await onSaved('高级配置区块已保存。');
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length) {
        setError(caught.issues.map((issue) => issue.message).join('\n'));
      } else {
        setError(caught instanceof Error ? caught.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">EXTENSIONS / FULL YAML</p>
          <h2>高级配置区块</h2>
          <p>
            管理 HTTP 引擎、脚本、定时任务、MTProto、StashLink 以及任何新版 Stash
            顶层字段。内容加密写入 SQLite。
          </p>
        </div>
        <button className="button primary" onClick={save} disabled={saving}>
          <Save size={16} />
          {saving ? '保存中…' : '保存高级区块'}
        </button>
      </div>

      <div className="preset-row">
        {PRESETS.filter((preset) => !sections.some((section) => section.key === preset)).map(
          (preset) => (
            <button
              className="preset-chip"
              key={preset}
              onClick={() =>
                setSections((current) => [
                  ...current,
                  { key: preset, text: '{}', original: {} }
                ])
              }
            >
              <Plus size={13} />
              {preset}
            </button>
          )
        )}
      </div>

      <div className="advanced-stack">
        {sections.map((section, index) => (
          <article className="advanced-card" key={`${section.key}-${index}`}>
            <header>
              <label className="field">
                <span>顶层 key</span>
                <input
                  className="input mono"
                  value={section.key}
                  onChange={(event) => updateSection(index, { key: event.target.value })}
                />
              </label>
              <button
                className="icon-button danger"
                aria-label="删除区块"
                onClick={() =>
                  setSections((current) =>
                    current.filter((_item, itemIndex) => itemIndex !== index)
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </header>
            <textarea
              className="code-input"
              rows={11}
              value={section.text}
              onChange={(event) => updateSection(index, { text: event.target.value })}
            />
          </article>
        ))}
        {sections.length === 0 ? (
          <div className="empty-state">
            <strong>没有高级区块</strong>
            <span>当前 Profile 只使用结构化区块。可从上方按需加入。</span>
          </div>
        ) : null}
      </div>
      {error ? <pre className="inline-error">{error}</pre> : null}
    </section>
  );
}
