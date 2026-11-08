'use client';

import { CONFIG_TARGETS, configTargetIds, type ConfigTarget } from '@/lib/config-targets';
import { StatusBadge } from './ui';
import type { DeliveryWorkspace } from './use-delivery-workspace';

export function DeliverySummary({ delivery, revision, onOpen }: {
  delivery: DeliveryWorkspace; revision: number; onOpen: (target: ConfigTarget) => void;
}) {
  return <section className="panel" aria-label="设备交付状态">
    <div className="panel-heading"><div><h2>设备交付状态</h2><p>当前编辑版 {revision}。两种客户端分别检查和交付。</p></div></div>
    {delivery.error ? <div role="alert"><p className="inline-error">{delivery.error}</p>
      <button className="button secondary small" onClick={() => void delivery.refresh()}>重试读取下载状态</button></div> : null}
    <div className="delivery-target-grid">
      {configTargetIds.map(target => {
        const status = delivery.targets[target];
        const problem = status?.issues?.some(issue => issue.severity === 'error');
        const sources = status?.managedSources ?? [];
        const sourceProblem = status?.remoteState === 'failed' || sources.some(source => ['failed', 'stale', 'revoked'].includes(source.state));
        const sourcePending = status?.remoteState === 'pending' || sources.some(source => source.state === 'pending');
        const label = problem ? '需要处理' : sourceProblem ? '远程来源有异常' : sourcePending ? '远程来源待检查'
          : status?.current ? '当前版可用' : status?.deliveryMode === 'manual' ? '手动发布'
            : status ? '尚无当前版' : delivery.error ? '状态不可用' : '读取中';
        return <article key={target} className="delivery-target-card">
          <div><strong>{CONFIG_TARGETS[target].label}</strong><StatusBadge tone={status?.current && !sourceProblem && !sourcePending ? 'good' : 'warn'}>{label}</StatusBadge></div>
          <p>{status?.compiledRevision != null ? `设备可下载版 ${status.compiledRevision}` : status ? '设备暂无可下载版本' : '设备版本未确认'}</p>
          <button className="button secondary small" onClick={() => onOpen(target)}>
            {problem ? '查看阻塞原因' : sourceProblem || sourcePending ? '查看来源状态' : status?.compiledRevision != null ? '打开下载' : '查看交付'}
          </button>
        </article>;
      })}
    </div>
  </section>;
}
