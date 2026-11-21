/** Shared by import classification, editors and compiler diagnostics. */
export const CONFIG_FORMAT_LABELS = { stash: 'Stash YAML', mihomo: 'Clash (Mihomo) YAML', shadowrocket: 'Shadowrocket .conf' } as const;
export const SHADOWROCKET_NODE_TYPES = ['ss', 'socks5', 'http', 'trojan', 'vmess'] as const;
export const MIHOMO_SECTIONS = ['tun', 'sniffer', 'listeners', 'geodata-mode', 'geox-url', 'profile', 'external-controller', 'external-ui', 'secret'] as const;
export const PROXY_SOURCE_OPTIONS = [
  { value: 'remote', label: '远程订阅（加密保存 URL）' },
  { value: 'local', label: '客户端本地文件（使用 path）' },
  { value: 'inline', label: '内联节点（Mihomo）' }
];

export function proxySourceType(config: Record<string, unknown>, requiresUrl = false): 'inline' | 'remote' | 'local' {
  return config.type === 'inline' ? 'inline' : requiresUrl || config.url ? 'remote' : 'local';
}
