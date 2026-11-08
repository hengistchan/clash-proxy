import { CONFIG_TARGETS, configTargetIds, type ConfigTarget } from '@/lib/config-targets';
import type { DraftCheck } from '@/lib/draft-check';
import { ValidationIssues } from './validation-issues';

export function ImportChecks({ checks }: { checks: Record<ConfigTarget, DraftCheck> }) {
  return <section className="import-preview wide" aria-label="导入后的客户端检查">
    <strong>导入后的客户端检查</strong>
    <div className="delivery-target-grid">
      {configTargetIds.map(target => {
        const { state, issues, servedRevision } = checks[target];
        return <article key={target} className="delivery-target-card">
          <strong>{CONFIG_TARGETS[target].label}</strong>
          <p>{state === 'ready' ? '通过静态检查' : state === 'pending' ? '通过静态检查，远程来源待检查' : '当前候选版无法交付'}</p>
          {servedRevision !== null && <p className="delivery-note">目前设备可下载版 {servedRevision}{state === 'blocked' ? '；导入后仍沿用此版' : ''}</p>}
          {!!issues.length && <details><summary>查看 {issues.length} 项检查结果</summary><ValidationIssues issues={issues} /></details>}
        </article>;
      })}
    </div>
    <p className="delivery-note">预览不会拉取远程来源，也不会更新设备版本。手动发布的客户端仍需单独发布。</p>
  </section>;
}
