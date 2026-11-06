'use client';
import { useState } from 'react';
import type { StashRule } from '@/lib/types';
import { apiRequest } from './api-client';
interface Simulation {
  candidate: StashRule | null;
  conclusive: boolean;
  explanation: string;
  uncertainRules: Array<{ priority: number; type: string }>;
}
export function RoutingSimulator({
  profileId,
  token
}: {
  profileId: number;
  token: string;
}) {
  const [host, setHost] = useState(''),
    [ip, setIp] = useState('');
  const [network, setNetwork] = useState(''),
    [protocol, setProtocol] = useState('');
  const [process, setProcess] = useState(''),
    [port, setPort] = useState('');
  const [result, setResult] = useState<Simulation | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function simulate() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await apiRequest<Simulation>(`/api/profiles/${profileId}/simulate`, {
          method: 'POST',
          token,
          body: JSON.stringify({
            host: host.trim() || undefined,
            ip: ip.trim() || undefined,
            network: network || undefined,
            protocol: protocol.trim() || undefined,
            process: process.trim() || undefined,
            port: port ? Number(port) : undefined
          })
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '模拟失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="simulator">
      <summary>解释一次路由匹配</summary>
      <p className="delivery-note">
        按当前页面顺序检查，不发送网络请求。远程规则集、GeoIP、脚本或缺失的输入会标为不确定，不会假装得到真实设备结果。
      </p>
      <div className="simulator-fields">
        <label className="field">
          <span>域名</span>
          <input
            className="input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
          />
        </label>
        <label className="field">
          <span>目标 IP（可选）</span>
          <input
            className="input"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
          />
        </label>
        <label className="field">
          <span>网络</span>
          <select
            className="input"
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
          >
            <option value="">未提供</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </label>
        <label className="field">
          <span>协议（可选）</span>
          <input
            className="input"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
            placeholder="TLS / QUIC …"
          />
        </label>
        <label className="field">
          <span>目标端口（可选）</span>
          <input
            className="input"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </label>
        <label className="field">
          <span>进程名（可选）</span>
          <input
            className="input"
            value={process}
            onChange={(e) => setProcess(e.target.value)}
          />
        </label>
      </div>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void simulate()}
      >
        {busy ? '检查中…' : '解释匹配结果'}
      </button>
      {result ? (
        <div className="simulator-result" role="status">
          <strong>
            {result.conclusive ? '本地确定结果' : '候选结果 · 仍有不确定项'}
          </strong>
          <p>
            {result.candidate
              ? `第 ${result.candidate.priority} 条：${result.candidate.type} ${result.candidate.payload} → ${result.candidate.policy}`
              : '未得到规则候选'}
          </p>
          <p>{result.explanation}</p>
          {result.uncertainRules.length ? (
            <p>
              前序不确定规则：
              {result.uncertainRules
                .map((r) => `${r.priority} (${r.type})`)
                .join('、')}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
    </details>
  );
}
