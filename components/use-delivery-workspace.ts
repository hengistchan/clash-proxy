'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api-client';
import { DEFAULT_CONFIG_TARGET, type ConfigDeliveryStatus, type ConfigTarget, type ProfileDeliveryStatus } from '@/lib/config-targets';

type Targets = Partial<Record<ConfigTarget, ConfigDeliveryStatus>>;

export function useDeliveryWorkspace(profileId: number | undefined, revision: number | undefined, token: string, screen: string) {
  const [target, setTarget] = useState<ConfigTarget>(DEFAULT_CONFIG_TARGET);
  const [data, setData] = useState<{ key: string; targets: Targets }>({ key: '', targets: {} });
  const [failure, setFailure] = useState<{ key: string; error: string }>();
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const key = `${profileId}:${revision}`;
  const refresh = useCallback(async () => {
    if (!profileId) return;
    const id = ++request.current;
    setPending(true);
    setFailure(undefined);
    try {
      const result = await apiRequest<ProfileDeliveryStatus>(`/api/profiles/${profileId}/delivery`, { token });
      if (id === request.current) setData({ key, targets: result.targets ?? { stash: result } });
    } catch (caught) {
      if (id === request.current) {
        setData({ key, targets: {} });
        setFailure({ key, error: caught instanceof Error ? caught.message : '读取下载状态失败' });
      }
    } finally {
      if (id === request.current) setPending(false);
    }
  }, [key, profileId, token]);

  useEffect(() => {
    if (screen === 'overview' || screen === 'export') void refresh();
    return () => { request.current++; };
  }, [refresh, screen]);
  useEffect(() => setTarget(DEFAULT_CONFIG_TARGET), [profileId]);

  function applyTargets(targets: Targets) {
    request.current++;
    setData({ key, targets });
    setPending(false);
    setFailure(undefined);
  }
  function applyTarget(client: ConfigTarget, status: ConfigDeliveryStatus | null) {
    request.current++;
    setPending(false);
    setData(previous => {
      const targets = previous.key === key ? { ...previous.targets } : {};
      if (status) targets[client] = status;
      else delete targets[client];
      return { key, targets };
    });
  }

  return {
    target, setTarget, targets: data.key === key ? data.targets : {},
    error: failure?.key === key ? failure.error : '', pending, refresh, applyTargets, applyTarget
  };
}

export type DeliveryWorkspace = ReturnType<typeof useDeliveryWorkspace>;
