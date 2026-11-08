import type { ValidationIssue } from './types';

export const CONFIG_TARGETS = {
  stash: {
    label: 'Stash',
    apiSegment: '',
    downloadLabel: 'YAML',
    bundle: true,
    importGuide: 'YAML 可直接导入 Stash。ZIP 包含配置、诊断和版本清单；远程订阅仍需联网，本地资源文件需另行准备。'
  },
  shadowrocket: {
    label: 'Shadowrocket',
    apiSegment: '/shadowrocket',
    downloadLabel: '.conf',
    bundle: false,
    importGuide: '在 Shadowrocket 的「配置」页导入 .conf 或添加下方的远程配置链接，然后将全局路由设为「配置」。'
  }
} as const;

export type ConfigTarget = keyof typeof CONFIG_TARGETS;
export const DEFAULT_CONFIG_TARGET: ConfigTarget = 'stash';
export const configTargetIds = Object.keys(CONFIG_TARGETS) as ConfigTarget[];

export interface ConfigDeliveryStatus {
  currentRevision: number | null;
  compiledRevision: number | null;
  current: boolean;
  generatedAt: string | null;
  subscriptionPath: string | null;
  subscriptionUrl?: string | null;
  configDownloadUrl?: string;
  issues?: ValidationIssue[];
  remoteSources?: boolean;
}

export function configTargetApi(profileId: number, target: ConfigTarget) {
  return `/api/profiles/${profileId}${CONFIG_TARGETS[target].apiSegment}`;
}

export interface ProfileDeliveryStatus extends ConfigDeliveryStatus {
  targets: Record<ConfigTarget, ConfigDeliveryStatus>;
}
