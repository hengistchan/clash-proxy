import { isJsonObject, type JsonObject } from './types';

const atom = (value: unknown): value is string => typeof value === 'string' && Boolean(value) && value === value.trim() && !/[,;#"'\\\s\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u.test(value);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const common = ['server', 'port', 'tls', 'sni', 'servername', 'skip-cert-verify', 'udp', 'tfo', 'network', 'ws-opts'];

/** A deliberately lossless TCP/TLS/WebSocket subset of native Trojan and VMess. */
export function extendedNodeParts(type: string, config: JsonObject): string[] | null {
  if (type !== 'trojan' && type !== 'vmess') return null;
  const fields = [...common, ...(type === 'trojan' ? ['password'] : ['uuid', 'alterId', 'cipher'])];
  if (Object.keys(config).some(key => !fields.includes(key))) return null;
  if (['tls', 'skip-cert-verify', 'udp', 'tfo'].some(key => config[key] !== undefined && typeof config[key] !== 'boolean')) return null;
  if (config.sni !== undefined && config.servername !== undefined && config.sni !== config.servername) return null;
  const sni = config.sni ?? config.servername;
  if (sni !== undefined && !atom(sni)) return null;
  if (config.network !== undefined && !['tcp', 'ws'].includes(String(config.network))) return null;
  const parts: string[] = [];
  if (type === 'trojan') {
    if (!atom(config.password) || config.tls === false) return null;
    parts.push(`password=${config.password}`);
  } else {
    if (typeof config.uuid !== 'string' || !uuid.test(config.uuid) || (config.alterId !== undefined && config.alterId !== 0) || (config.cipher !== undefined && config.cipher !== 'auto')) return null;
    parts.push(`username=${config.uuid}`, 'vmess-aead=true', `tls=${config.tls ?? false}`);
    if (config.tls !== true && (sni !== undefined || config['skip-cert-verify'] !== undefined)) return null;
  }
  if (sni !== undefined) parts.push(`sni=${sni}`);
  if (config['skip-cert-verify'] !== undefined) parts.push(`skip-cert-verify=${config['skip-cert-verify']}`);
  for (const [key, native] of [['udp', 'udp-relay'], ['tfo', 'tfo']] as const) if (config[key] !== undefined) parts.push(`${native}=${config[key]}`);
  if (config.network === 'ws') {
    const ws = config['ws-opts'];
    if (ws !== undefined && (!isJsonObject(ws) || Object.keys(ws).some(key => !['path', 'headers'].includes(key)))) return null;
    parts.push('ws=true');
    if (isJsonObject(ws)) {
      if (ws.path !== undefined) { if (!atom(ws.path) || !ws.path.startsWith('/')) return null; parts.push(`ws-path=${ws.path}`); }
      if (ws.headers !== undefined) {
        if (!isJsonObject(ws.headers) || Object.keys(ws.headers).length !== 1 || !atom(ws.headers.Host)) return null;
        parts.push(`ws-headers=Host:${ws.headers.Host}`);
      }
    }
  } else if (config['ws-opts'] !== undefined) return null;
  return parts;
}

export function parseExtendedNode(type: string, options: Map<string, string>, members: string[]): JsonObject | null {
  if (members.length || !['trojan', 'vmess'].includes(type)) return null;
  if (type === 'vmess' && !['true', '1'].includes(options.get('vmess-aead') ?? '')) return null;
  const config: JsonObject = type === 'trojan' ? { tls: true } : { alterId: 0 };
  const bool = (value: string) => value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : null;
  const ws: JsonObject = {};
  for (const [key, value] of options) {
    if (key === 'password' && type === 'trojan') config.password = value;
    else if ((key === 'username' || key === 'password') && type === 'vmess') { if (config.uuid !== undefined) return null; config.uuid = value; }
    else if (key === 'sni') config.sni = value;
    else if (['tls', 'skip-cert-verify', 'udp-relay', 'tfo'].includes(key)) {
      const parsed = bool(value); if (parsed === null) return null;
      config[key === 'udp-relay' ? 'udp' : key] = parsed;
    } else if (key === 'vmess-aead' && type === 'vmess') { if (bool(value) !== true) return null; }
    else if (key === 'ws') { const parsed = bool(value); if (parsed === null) return null; config.network = parsed ? 'ws' : 'tcp'; }
    else if (key === 'ws-path') ws.path = value;
    else if (key === 'ws-headers' && value.startsWith('Host:')) ws.headers = { Host: value.slice(5) };
    else return null;
  }
  if (Object.keys(ws).length) config['ws-opts'] = ws;
  return extendedNodeParts(type, config) ? config : null;
}
