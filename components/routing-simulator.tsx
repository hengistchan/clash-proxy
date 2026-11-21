'use client';
import { useEffect, useState } from 'react';
import type { StashRule } from '@/lib/types';
import { apiRequest } from './api-client';
interface Simulation {
  candidate: StashRule | null;
  conclusive: boolean;
  explanation: string;
  uncertainRules: Array<{ priority: number; type: string }>;
  sourceSnapshots?: Array<{ providerId: number; checkedAt: number | null; usable: boolean }>;
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
  const [sources, setSources] = useState('');
  const [useCheckedSources, setUseCheckedSources] = useState(false);
  useEffect(() => { setResult(null); }, [host, ip, network, protocol, process, port, useCheckedSources]);
  async function checkSources() {
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await apiRequest<{ results: Array<{ state: string }> }>(`/api/profiles/${profileId}/simulate/sources`, { method: 'POST', token });
      setSources(`已检查 ${response.results.length} 个远程规则集，${response.results.filter(item => item.state === 'failed').length} 个失败。快照有效期 15 分钟；未加载、过期和 MRS 规则仍标为不确定。`);
      setUseCheckedSources(true);
    } catch (error) { setError(error instanceof Error ? error.message : '来源检查失败'); }
    finally { setBusy(false); }
  }
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
            useCheckedSources,
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
        按保存的规则顺序解释匹配。可主动检查远程规则集并使用近期快照；GeoIP、脚本或缺失的输入仍标为不确定，结果需要在设备上验证。
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
      <button type="button" className="button secondary" disabled={busy} onClick={() => void checkSources()}>检查远程规则集</button>
      <label className="delivery-note"><input type="checkbox" checked={useCheckedSources} onChange={event => setUseCheckedSources(event.target.checked)} />使用已检查的来源快照</label>
      {sources ? <p className="delivery-note" role="status">{sources}</p> : null}
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
          {result.sourceSnapshots?.length ? <p>来源快照：{result.sourceSnapshots.filter(source => source.usable).length} / {result.sourceSnapshots.length} 个有效。{result.sourceSnapshots.filter(source => source.usable && source.checkedAt).map(source => `规则集 ${source.providerId}：${new Date(source.checkedAt!).toLocaleString('zh-CN')}`).join('；')}</p> : null}
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
