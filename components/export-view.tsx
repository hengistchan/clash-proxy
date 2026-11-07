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

interface DeliveryStatus {
  currentRevision: number;
  compiledRevision: number | null;
  current: boolean;
  generatedAt: string | null;
  subscriptionPath: string | null;
  subscriptionUrl?: string | null;
}
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
  const [status, setStatus] = useState<DeliveryStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [origin, setOrigin] = useState('');
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [changingLink, setChangingLink] = useState(false);
  const [pendingLinkChange, setPendingLinkChange] = useState<'rotate' | 'revoke' | null>(null);
  const actionLock = useRef(false);
  useUnsavedChanges(false, changingLink);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setError('');
    setNotice('');
    setOrigin(window.location.origin);
    apiRequest<DeliveryStatus>(`/api/profiles/${profileId}/delivery`, { token })
      .then((data) => {
        if (active) setStatus(data);
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
  }, [profileId, snapshot.profile.revision, token, statusAttempt]);
  async function download(bundle = false) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/profiles/${profileId}/${bundle ? 'bundle' : 'config_download'}`,
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
        await apiRequest(`/api/profiles/${profileId}/download-link`, { method: 'DELETE', token });
        if (previous) setStatus({ ...previous, subscriptionPath: null, subscriptionUrl: null });
      } else {
        const next = await apiRequest<DeliveryStatus>(`/api/profiles/${profileId}/download-link`, { method: 'POST', token });
        setStatus(next);
      }
      setNotice(revoke ? '订阅链接已撤销。' : '新订阅链接已生成，之前的链接已失效。');
    } catch (caught) {
      setError((caught instanceof Error ? caught.message : '链接操作失败') + ' 请重新读取下载状态以确认链接。');
    } finally {
      actionLock.current = false;
      setBusy(false);
      setChangingLink(false);
    }
  }

  const errors = validation.issues.filter((i) => i.severity === 'error');
  const missing = snapshot.proxyProviders.filter((p) => !p.sourceConfigured);
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
              : '等待配置完成'}
        </StatusBadge>
      </div>
      {missing.length ? (
        <p className="inline-error">
          待配置来源：{missing.map((p) => p.name).join('、')}
          。请打开“代理源”填写各自的订阅地址或本地文件路径。
        </p>
      ) : null}
      {status && !status.current && status.compiledRevision !== null ? (
        <p className="delivery-note">
          最新修改（版本 {status.currentRevision}
          ）尚未通过检查。下载和设备订阅仍使用最近成功的版本{' '}
          {status.compiledRevision}。
        </p>
      ) : null}
      <div className="delivery-actions">
        <button
          className="button primary"
          disabled={busy || status?.compiledRevision == null}
          onClick={() => void download()}
        >
          <Download size={16} />
          下载 YAML
        </button>
        <button
          className="button secondary"
          disabled={busy || status?.compiledRevision == null}
          onClick={() => void download(true)}
        >
          下载交付 ZIP
        </button>
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
            YAML 可直接导入 Stash。ZIP
            包含配置、诊断和版本清单；远程订阅仍需联网，本地资源文件需另行准备。下载文件可能含私人凭据。
          </p>
          <div className="section-rule">
            <span>设备订阅链接</span>
          </div>
          <p className="delivery-note">
            生成后可粘贴到
            Stash；后续保存并检查成功的配置会自动更新。持有此链接的人可下载完整私人配置。
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
                  disabled={busy}
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
                disabled={busy || status?.compiledRevision == null}
                onClick={() => requestLinkChange()}
              >
                <Link2 size={15} />
                生成固定订阅链接
              </button>
            </div>
          )}
          <details className="export-contract">
            <summary>开发者 API</summary>
            <code>GET /api/profiles/{profileId}/config_download</code>
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
            ? '撤销后，所有设备都无法再通过旧链接更新配置。'
            : '更换后，旧链接立即失效，所有设备都需要重新填写新链接。'
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
