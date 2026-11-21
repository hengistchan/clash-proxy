'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Profile, Snapshot, ValidationResult } from '@/lib/types';
import { ApiError, apiRequest } from './api-client';

type SnapshotResponse = Snapshot & { validation: ValidationResult };

interface Meta {
  rule_types: string[];
  rule_options: string[];
  proxy_group_types: string[];
  builtin_policies: string[];
  admin_token_required: boolean;
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

export type Notify = (message: string, tone?: 'good' | 'bad' | 'warn') => void;

export function useWorkspaceSession(notify: Notify) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({
    valid: false,
    issues: []
  });
  const [token, setToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const snapshotRequest = useRef(0);
  const initialiseRequest = useRef(0);
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
    return () => { initialiseRequest.current++; snapshotRequest.current++; };
  }, [initialise]);

  async function unlock() {
    const value = tokenDraft.trim();
    setToken(value);
    writeSessionToken(value);
    await initialise(value, profileId ?? readSessionProfile());
  }

  return { meta, profiles, setProfiles, profileId, snapshot, validation, token, tokenDraft, setTokenDraft, authRequired, loading, refreshing, connectionError, loadSnapshot, initialise, initialiseRequest, handleError, unlock };
}

export function useWorkspaceNotifications() {
  const [toast, setToast] = useState<{
    message: string;
    tone: 'good' | 'bad' | 'warn';
  } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const notify = useCallback(
    (message: string, tone: 'good' | 'bad' | 'warn' = 'good') => {
      setToast({ message, tone });
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 5200);
    },
    []
  );

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);
  return { toast, notify };
}
