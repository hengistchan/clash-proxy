'use client';
import type { ConfigDiff } from '@/lib/config-diff';

export function ConfigDiffView({ diff }: { diff: ConfigDiff }) {
  return <div className="config-diff">
    <p className="diff-summary">新增 {diff.added} 项 · 删除 {diff.removed} 项 · 修改 {diff.changed} 项{diff.orderChanged.length ? ` · ${diff.orderChanged.length} 类资源顺序变化` : ''}</p>
    {!diff.totalChanges && !diff.orderChanged.length ? <p className="delivery-note">配置内容没有语义变化。</p> : null}
    {diff.orderChanged.length ? <p className="delivery-note">顺序发生变化：{diff.orderChanged.join('、')}。路由和组成员顺序会影响设备行为。</p> : null}
    <div className="diff-list">
      {diff.changes.map((change, index) => <article className={`diff-item diff-${change.change}`} key={`${change.resource}-${index}`}>
        <span className="diff-kind">{{ added: '新增', removed: '删除', changed: '修改' }[change.change]}</span>
        <div><strong>{change.label}</strong><small>{change.resource}{change.fields.length ? ` · ${change.fields.join('、')}` : ''}</small></div>
      </article>)}
    </div>
    {diff.truncated ? <p className="delivery-note">共 {diff.totalChanges} 项变化，仅列出前 {diff.changes.length} 项；上方统计包含全部变化。</p> : null}
    <p className="delivery-note">摘要只展示资源和变化类型，私人连接参数与凭据不会显示。</p>
  </div>;
}
