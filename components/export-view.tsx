'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Link2, RefreshCw } from 'lucide-react';
import type { Snapshot, ValidationResult, ValidationIssue } from '@/lib/types';
import {
  apiRequest,
  downloadBlob,
  filenameFromDisposition
} from './api-client';
import { useUnsavedChanges } from './unsaved-changes';
import { ValidationIssues } from './validation-issues';
import { Modal, StatusBadge } from './ui';
import {
  CONFIG_TARGETS, DEFAULT_CONFIG_TARGET, configTargetApi, configTargetIds,
  type ConfigTarget, type ConfigDeliveryStatus, type ProfileDeliveryStatus
} from '@/lib/config-targets';

export function ExportView({
  snapshot,
  validation,
  profileId,
  token,
  compact = false,
  onFixIssue
}: {
  snapshot: Snapshot;
  validation: ValidationResult;
  profileId: number;
  token: string;
  compact?: boolean;
  onFixIssue?: (issue: ValidationIssue) => void;
}) {
  const [status, setStatus] = useState<ConfigDeliveryStatus | null>(null);
  const [target, setTarget] = useState<ConfigTarget>(DEFAULT_CONFIG_TARGET);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [origin, setOrigin] = useState('');
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [changingLink, setChangingLink] = useState(false);
  const [pendingLinkChange, setPendingLinkChange] = useState<'rotate' | 'revoke' | null>(null);
  const actionLock = useRef(false);
  const targetConfig = CONFIG_TARGETS[target];
  const isDefault = target === DEFAULT_CONFIG_TARGET;
  const client = targetConfig.label;
  const targetApi = configTargetApi(profileId, target);
  useUnsavedChanges(false, changingLink);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setError('');
    setNotice('');
    setOrigin(window.location.origin);
    apiRequest<ProfileDeliveryStatus>(`/api/profiles/${profileId}/delivery`, { token })
      .then((data) => {
        if (active) setStatus(data.targets?.[target] ?? (isDefault ? data : null));
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : '读取下载状态失败'
          );
      });
    return () => {
      active = false;
    };
  }, [profileId, snapshot.profile.revision, token, statusAttempt, target, isDefault]);
  async function readRemoteDiagnostics() {
    if (!status?.remoteSources && !status?.managedProxySources) return;
    try {
      const data = await apiRequest<ProfileDeliveryStatus>(`/api/profiles/${profileId}/delivery`, { token });
      setStatus(data.targets[target]);
    } catch {
      // Keep the download result visible; the user can retry reading status.
    }
  }
  async function download(bundle = false) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `${targetApi}/${bundle ? 'bundle' : 'config_download'}`,
        {
          headers: token ? { 'X-Admin-Token': token } : {}
        }
      );
      if (!response.ok)
        throw new Error((await response.json()).detail || '下载失败');
      downloadBlob(
        await response.blob(),
        filenameFromDisposition(response.headers.get('content-disposition'))
      );
      setNotice('已下载最近成功生成的版本。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '下载失败');
    } finally {
      await readRemoteDiagnostics();
      actionLock.current = false;
      setBusy(false);
    }
  }
  function requestLinkChange(revoke = false) {
    if (actionLock.current) return;
    if (!status?.subscriptionPath) {
      void changeLink(revoke);
      return;
    }
    setPendingLinkChange(revoke ? 'revoke' : 'rotate');
  }
  async function confirmLinkChange() {
    const revoke = pendingLinkChange === 'revoke';
    setPendingLinkChange(null);
    await changeLink(revoke);
  }
  async function changeLink(revoke = false) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setChangingLink(true);
    setError('');
    setNotice('');
    const previous = status;
    setStatus(null);
    try {
      if (revoke) {
        await apiRequest(`${targetApi}/download-link`, { method: 'DELETE', token });
        if (previous) setStatus({ ...previous, subscriptionPath: null, subscriptionUrl: null });
      } else {
        const next = await apiRequest<ConfigDeliveryStatus>(`${targetApi}/download-link`, { method: 'POST', token });
        setStatus(next);
      }
      setNotice(revoke ? '订阅链接已撤销。' : '新订阅链接已生成，之前的链接已失效。');
    } catch (caught) {
      await readRemoteDiagnostics();
      setError((caught instanceof Error ? caught.message : '链接操作失败') + ' 请重新读取下载状态以确认链接。');
    } finally {
      actionLock.current = false;
      setBusy(false);
      setChangingLink(false);
    }
  }

  const errors = validation.issues.filter((i) => i.severity === 'error');
  const missing = snapshot.proxyProviders.filter((p) => !p.sourceConfigured);
  const compatibility = status?.issues ?? [];
  const canDownload = status?.compiledRevision != null || Boolean(status?.remoteSources);
  const sourceFailed = status?.remoteSources && compatibility.some((issue) => issue.severity === 'error');
  return (
    <section className="panel export-panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">CONFIGURATION / DOWNLOAD</p>
          <h2>{compact ? '配置与下载' : '下载配置'}</h2>
          <p>保存后自动检查并生成可用版本；订阅来源在各代理源中维护。</p>
        </div>
        <StatusBadge tone={status?.current ? 'good' : 'warn'}>
          {status?.current
            ? `版本 ${status.compiledRevision} 可用`
            : status?.compiledRevision
              ? `继续提供版本 ${status.compiledRevision}`
              : sourceFailed ? '远程来源检查未通过'
                : status?.remoteSources ? '等待拉取远程来源' : '等待配置完成'}
        </StatusBadge>
      </div>
      {!compact ? (
        <div className="delivery-actions" role="group" aria-label="配置客户端">
          {configTargetIds.map((option) => (
            <button
              key={option}
              className={`button small ${target === option ? 'primary' : 'secondary'}`}
              aria-pressed={target === option}
              disabled={busy || pendingLinkChange !== null}
              onClick={() => {
                if (target === option || actionLock.current) return;
                setStatus(null);
                setTarget(option);
              }}
            >
              {CONFIG_TARGETS[option].label}
            </button>
          ))}
        </div>
      ) : null}
      {isDefault && missing.length ? (
        <p className="inline-error">
          待配置来源：{missing.map((p) => p.name).join('、')}
          。请打开“代理源”填写各自的订阅地址或本地文件路径。
        </p>
      ) : null}
      {status && !status.current && status.compiledRevision !== null ? (
        <p className="delivery-note">
          {status.remoteSources && status.currentRevision === status.compiledRevision
            ? '最近一次远程来源更新未通过检查。'
            : <>最新修改（版本 {status.currentRevision}）尚未通过{isDefault ? '' : ` ${client} `}检查。</>}
          下载和设备订阅仍使用最近成功的版本{' '}
          {status.compiledRevision}。
        </p>
      ) : null}
      {compatibility.length ? (
        <div className="validation-block">
          <strong>{client} 兼容性检查</strong>
          <ValidationIssues issues={compatibility} onFix={onFixIssue} />
        </div>
      ) : null}
      {isDefault && status?.managedProxySources && <p className="delivery-note">
        这份配置中的改写代理源由工作台提供。下载时会启用设备订阅链接；更换或撤销链接后，请重新下载并导入配置。
      </p>}
      <div className="delivery-actions">
        <button
          className="button primary"
          disabled={busy || !canDownload}
          onClick={() => void download()}
        >
          <Download size={16} />
          {busy && status?.remoteSources ? '正在处理…' : `下载 ${targetConfig.downloadLabel}`}
        </button>
        {targetConfig.bundle ? <button
          className="button secondary"
          disabled={busy || status?.compiledRevision == null}
          onClick={() => void download(true)}
        >
          下载交付 ZIP
        </button> : null}
        <a
          className="button secondary"
          href="/docs/api"
          target="_blank"
          rel="noreferrer"
        >
          API 使用文档
        </a>
      </div>
      {!compact ? (
        <>
          <p className="delivery-note">
            {targetConfig.importGuide} 下载文件可能含私人凭据。
          </p>
          <div className="section-rule">
            <span>设备订阅链接</span>
          </div>
          <p className="delivery-note">
            将链接添加到 {client}。客户端更新时会获取该端最近通过检查的版本。持有此链接的人可下载完整私人配置。
          </p>
          {status?.subscriptionPath ? (
            <>
              <input
                className="input mono"
                aria-label="固定配置订阅链接"
                readOnly
                value={
                  status.subscriptionUrl || origin + status.subscriptionPath
                }
              />
              <div className="delivery-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(
                        status.subscriptionUrl ||
                          origin + status.subscriptionPath
                      )
                      .then(() => setNotice('订阅链接已复制。'))
                      .catch(() => setError('复制失败，请手动选择链接复制。'))
                  }
                >
                  复制链接
                </button>
                <button
                  className="button secondary"
                disabled={busy || !canDownload}
                  onClick={() => requestLinkChange()}
                >
                  <RefreshCw size={15} />
                  更换链接
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => requestLinkChange(true)}
                >
                  撤销链接
                </button>
              </div>
            </>
          ) : (
            <div className="delivery-actions">
              <button
                className="button secondary"
                disabled={busy || !canDownload}
                onClick={() => requestLinkChange()}
              >
                <Link2 size={15} />
                生成固定订阅链接
              </button>
            </div>
          )}
          <details className="export-contract">
            <summary>开发者 API</summary>
            <code>GET {targetApi}/config_download</code>
            <p>
              管理 API
              使用管理员认证；设备使用上面的独立订阅链接。无需传入任何订阅地址参数。
            </p>
          </details>
        </>
      ) : null}
      {!compact && errors.length ? (
        <div className="validation-block error-block">
          <strong>最新修改需要修复 {errors.length} 个问题</strong>
          <ValidationIssues issues={errors} onFix={onFixIssue} />
        </div>
      ) : null}
      <Modal
        open={pendingLinkChange !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingLinkChange(null);
        }}
        title={pendingLinkChange === 'revoke' ? '撤销固定订阅链接？' : '更换固定订阅链接？'}
        description={
          pendingLinkChange === 'revoke'
            ? `撤销后，使用该链接的 ${client} 设备将无法再更新配置。`
            : `更换后，旧链接立即失效，使用该链接的 ${client} 设备需要填写新链接。`
        }
        footer={
          <>
            <button
              className="button secondary"
              onClick={() => setPendingLinkChange(null)}
              disabled={busy}
            >
              取消
            </button>
            <button
              className={pendingLinkChange === 'revoke' ? 'button danger' : 'button primary'}
              onClick={confirmLinkChange}
              disabled={busy}
            >
              {busy ? '处理中…' : pendingLinkChange === 'revoke' ? '撤销' : '更换'}
            </button>
          </>
        }
      >
        <p className="delivery-note">
          设备需要重新导入新的订阅链接才能继续自动更新。
        </p>
      </Modal>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <div role="alert">
        <pre className="inline-error">{error}</pre>
        <button className="button secondary small" disabled={busy} onClick={() => setStatusAttempt((attempt) => attempt + 1)}>重试读取下载状态</button>
      </div> : null}
    </section>
  );
}
