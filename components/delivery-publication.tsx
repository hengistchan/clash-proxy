'use client';

import { useRef, useState } from 'react';
import type { ConfigDeliveryStatus, ConfigTarget } from '@/lib/config-targets';
import type { PublicationAction } from '@/lib/target-publication';
import { CONFIG_TARGETS } from '@/lib/config-targets';
import { apiRequest } from './api-client';
import type { DeliveryWorkspace } from './use-delivery-workspace';
import { Modal, StatusBadge } from './ui';
import { useUnsavedChanges } from './unsaved-changes';

interface Controls {
  profileId: number;
  token: string;
  status: ConfigDeliveryStatus;
  delivery: DeliveryWorkspace;
  disabled: boolean;
}
type TargetResponse = { targets: Record<ConfigTarget, ConfigDeliveryStatus> };

const names: Record<PublicationAction, string> = {
  manual: '启用手动发布', auto: '恢复自动发布', publish: '发布当前编辑版', rollback: '回退设备版本'
};
const sourceLabels = { pending: '待检查', ready: '最近检查成功', stale: '沿用上次成功结果', failed: '检查失败，无可用缓存', revoked: '链接已撤销' } as const;
const dateLabel = (value: number | string) => new Date(value).toLocaleString('zh-CN');

export function DeliveryPublication({ profileId, revision, token, target, status, delivery, disabled }: Controls & {
  target: ConfigTarget; revision: number;
}) {
  const [pending, setPending] = useState<{ action: PublicationAction; publicationId?: number; version?: number }>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mode = status.deliveryMode ?? 'auto';
  const client = CONFIG_TARGETS[target].label;
  const root = `/api/profiles/${profileId}/delivery/${target}`;
  useUnsavedChanges(false, working);

  async function run(check: boolean) {
    if (lock.current || (!check && !pending)) return;
    lock.current = true;
    setWorking(true);
    setError('');
    try {
      const response = await apiRequest<TargetResponse>(`${root}/${check ? 'check' : 'publication'}`, {
        method: 'POST', token,
        ...(check ? {} : {
          expectedRevision: revision,
          body: JSON.stringify({
            action: pending!.action, publicationId: pending!.publicationId,
            expectedMode: mode, expectedPublicationId: status.publicationId ?? null
          })
        })
      });
      delivery.applyTargets(response.targets);
      setPending(undefined);
    } catch (caught) {
      setPending(undefined);
      setError(caught instanceof Error ? caught.message : '操作失败');
    } finally {
      setWorking(false);
      lock.current = false;
    }
  }

  const canPublish = status.readyRevision === revision && status.remoteState !== 'pending' &&
    !status.issues?.some(issue => issue.severity === 'error') &&
    (status.compiledRevision !== revision || status.remoteState === 'ready');
  return <section className="delivery-subsection" aria-label={`${client} 发布设置`}>
    <div className="section-rule"><span>发布方式</span></div>
    <p className="delivery-note">当前编辑版 {revision} · 设备{status.compiledRevision == null ? '暂无可下载版本' : `可下载版 ${status.compiledRevision}`}</p>
    <p className="delivery-note">{mode === 'manual'
      ? '保存和检查不会更新设备版本。发布或回退只影响此客户端。'
      : '通过检查的版本自动提供给此客户端。手动发布可以固定设备当前使用的版本。'}</p>
    {target === 'shadowrocket' && status.remoteSources ? <div className="delivery-actions">
      <span className="delivery-note">{status.remoteState === 'failed' ? '最近一次远程检查失败' : status.remoteState === 'ready'
        ? '最近一次远程检查成功' : '等待检查远程来源'}{status.remoteCheckedAt ? ` · ${dateLabel(status.remoteCheckedAt)}` : ''}</span>
      <button className="button secondary small" disabled={working || disabled} onClick={() => void run(true)}>
        {working && !pending ? '检查中…' : '检查远程来源'}
      </button>
    </div> : null}
    <div className="delivery-actions">
      {mode === 'manual' ? <>
        <button className="button secondary small" disabled={working || disabled || !canPublish} onClick={() => setPending({ action: 'publish', version: revision })}>{names.publish}</button>
        <button className="button secondary small" disabled={working || disabled} onClick={() => setPending({ action: 'auto' })}>{names.auto}</button>
      </> : <button className="button secondary small" disabled={working || disabled} onClick={() => setPending({ action: 'manual' })}>{names.manual}</button>}
    </div>
    {mode === 'manual' && status.publications?.some(row => row.id !== status.publicationId) ? <details className="export-contract">
      <summary>查看已发布版本</summary>
      <ul className="delivery-release-list">
        {status.publications.map(row => <li key={row.id}>
          <span>版本 {row.revision} · {dateLabel(row.publishedAt)}</span>
          {row.id === status.publicationId ? <StatusBadge tone="good">正在交付</StatusBadge>
            : <button className="button secondary small" disabled={working || disabled} onClick={() => setPending({ action: 'rollback', publicationId: row.id, version: row.revision })}>回退到版本 {row.revision}</button>}
        </li>)}
      </ul>
    </details> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <Modal open={Boolean(pending)} onOpenChange={open => { if (!open && !working) setPending(undefined); }}
      title={pending ? `${names[pending.action]}？` : '发布设置'}
      description={pending?.action === 'manual' ? `${client} 将保留当前设备版本，直到你主动发布。`
        : pending?.action === 'auto' ? `${client} 会重新交付最近通过检查的版本。`
          : `${client} 的下载和订阅将使用版本 ${pending?.version}，其他客户端和编辑内容保持不变。`}
      footer={<><button className="button secondary" disabled={working} onClick={() => setPending(undefined)}>取消</button>
        <button className="button primary" disabled={working} onClick={() => void run(false)}>{working ? '处理中…' : '确认'}</button></>}>
      <p className="delivery-note">现有设备订阅链接保持不变。</p>
    </Modal>
  </section>;
}

export function ManagedSourceControls({ profileId, token, status, delivery, disabled, target }: Controls & { target: ConfigTarget }) {
  type Source = NonNullable<ConfigDeliveryStatus['managedSources']>[number];
  const [pending, setPending] = useState<{ source: Source; action: 'rotate' | 'revoke' }>();
  const [working, setWorking] = useState<number | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useUnsavedChanges(false, working !== null);
  async function run(id: number, action: 'check' | 'rotate' | 'revoke') {
    if (lock.current) return;
    lock.current = true;
    setWorking(id);
    setError('');
    try {
      const path = action === 'check' ? `check?sourceId=${id}` : `sources/${id}`;
      const response = await apiRequest<TargetResponse>(`/api/profiles/${profileId}/delivery/${target}/${path}`, { method: action === 'revoke' ? 'DELETE' : 'POST', token });
      delivery.applyTargets(response.targets);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败');
    } finally {
      setPending(undefined);
      setWorking(null);
      lock.current = false;
    }
  }
  return <section className="delivery-subsection" aria-label="托管代理源">
    <div className="section-rule"><span>设备版本中的托管代理源</span></div>
    <ul className="delivery-release-list">
      {status.managedSources?.map(source => <li key={source.id}>
        <div><strong>{source.name}</strong><p className="delivery-note">{sourceLabels[source.state]}
          {source.lastSuccess ? ` · 上次成功 ${dateLabel(source.lastSuccess)}` : ''}</p></div>
        <div className="delivery-actions">
          {source.state !== 'revoked' ? <>
            <button className="button secondary small" disabled={disabled || working !== null} onClick={() => void run(source.id, 'check')}>检查来源</button>
            <button className="button secondary small" disabled={disabled || working !== null} onClick={() => setPending({ source, action: 'revoke' })}>撤销代理源链接</button>
          </> : null}
          <button className="button secondary small" disabled={disabled || working !== null} onClick={() => setPending({ source, action: 'rotate' })}>
            {source.state === 'revoked' ? '重新启用代理源链接' : '更换代理源链接'}
          </button>
        </div>
      </li>)}
    </ul>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <Modal open={Boolean(pending)} onOpenChange={open => { if (!open && working === null) setPending(undefined); }}
      title={pending?.action === 'revoke' ? '撤销代理源链接？' : pending?.source.state === 'revoked' ? '重新启用代理源链接？' : '更换代理源链接？'}
      description={pending?.action === 'revoke'
        ? `「${pending.source.name}」将停止提供节点列表，直到重新启用。已缓存的节点可能仍留在设备上。`
        : `「${pending?.source.name ?? ''}」将使用新链接。设备请刷新整份配置，手动导入的设备请重新下载并导入。`}
      footer={<><button className="button secondary" disabled={working !== null} onClick={() => setPending(undefined)}>取消</button>
        <button className="button danger" disabled={working !== null} onClick={() => pending && void run(pending.source.id, pending.action)}>
          {pending?.action === 'revoke' ? '确认撤销' : pending?.source.state === 'revoked' ? '确认启用' : '确认更换'}</button></>}>
      <p className="delivery-note">其他代理源和整份配置的设备订阅链接保持不变。</p>
    </Modal>
  </section>;
}
