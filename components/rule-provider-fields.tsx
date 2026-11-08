'use client';

import type { RuleProvider } from '@/lib/types';
import { ConfigFields } from './config-fields';
import { SelectField, SwitchField } from './ui';

type TextChange = (text: string) => void;
type Toggle = (enabled: boolean) => void;

export function RuleProviderFields({
  name, setName, configText, setConfigText, sourceUrl, setSourceUrl,
  sourceHeaders, setSourceHeaders, clearSource, setClearSource, clearHeaders, setClearHeaders,
  provider, displayName, setDisplayName, providerType, changeProviderType, providerBehavior,
  setProviderBehavior, entriesText, setEntriesText, stashText, setStashText, referenceType,
  setShadowrocketText, shadowrocketSourceUrl, setShadowrocketSourceUrl, clearShadowrocketSource, setClearShadowrocketSource
}: {
  name: string; setName: TextChange; configText: string; setConfigText: TextChange;
  sourceUrl: string; setSourceUrl: TextChange; sourceHeaders: string; setSourceHeaders: TextChange;
  clearSource: boolean; setClearSource: Toggle; clearHeaders: boolean; setClearHeaders: Toggle;
  provider: RuleProvider | null; displayName: string; setDisplayName: TextChange;
  providerType: string; changeProviderType: TextChange; providerBehavior: string; setProviderBehavior: TextChange;
  entriesText: string; setEntriesText: TextChange; stashText: string; setStashText: TextChange;
  referenceType: string; setShadowrocketText: TextChange; shadowrocketSourceUrl: string;
  setShadowrocketSourceUrl: TextChange; clearShadowrocketSource: boolean; setClearShadowrocketSource: Toggle;
}) {
  return (
    <>
      <label className="field">
        <span>Stash 规则集标识</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <small>
          写入 YAML 并供 RULE-SET 引用；修改时会同步更新引用。
        </small>
      </label>
      <label className="field">
        <span>界面显示名称</span>
        <input
          className="input"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="例如：办公服务域名"
        />
        <small>
          只保存在管理数据库中，不会导出到 Stash YAML；留空时显示 Stash
          标识。
        </small>
      </label>
      <SelectField
        label="来源类型"
        value={providerType}
        onValueChange={changeProviderType}
        options={[
          { value: 'inline', label: 'inline / 数据库条目' },
          { value: 'remote', label: 'remote / 远程 URL' },
          { value: 'local', label: 'local / 本地 path' }
        ]}
      />
      <SelectField
        label="Behavior"
        value={providerBehavior}
        onValueChange={setProviderBehavior}
        options={[
          { value: 'domain', label: 'domain' },
          { value: 'ipcidr', label: 'ipcidr' },
          { value: 'classical', label: 'classical' }
        ]}
      />
      <label className="field wide">
        <span>Inline 条目（每行一个）</span>
        <textarea
          className="code-input"
          rows={10}
          value={entriesText}
          onChange={(event) => setEntriesText(event.target.value)}
          placeholder={'+.example.com\nexample.org'}
          disabled={providerType !== 'inline'}
        />
      </label>
      <p className="delivery-note wide">来源类型决定 Stash 如何加载规则；切换后不适用的来源字段会被移除，保存为本地或 inline 时会清除远程地址和认证。</p>
      {providerType === 'inline' && (configText.trim() !== '{}' || stashText.trim() !== '{}') ? <div className="wide">
        <p className="delivery-note">Inline 来源只使用上面的条目。旧配置中残留的来源参数需要清理后才能保存。</p>
        <button className="button secondary small" onClick={() => { setConfigText('{}'); setStashText('{}'); setSourceUrl(''); setSourceHeaders(''); }}>清理 inline 来源参数</button>
      </div> : null}
      {providerType === 'remote' ? <>
        <label className="field wide">
          <span>私人规则集地址（HTTP/HTTPS）</span>
          <input className="input mono" type="password" autoComplete="off" value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)} disabled={clearSource}
            placeholder={provider?.sourceConfigured ? '已保存；留空保留当前地址' : '填写远程规则集地址'} />
          <small>已保存的地址不会回显；缓存 path 不会替代远程来源。</small>
        </label>
        <ConfigFields label="规则集认证请求头" text={sourceHeaders || '{}'} onChange={setSourceHeaders} />
        <SwitchField label="清除规则集地址" checked={clearSource} onCheckedChange={setClearSource} description="清除后草稿无法发布；最近成功版本仍可下载。" />
        <SwitchField label="清除规则集认证请求头" checked={clearHeaders} onCheckedChange={setClearHeaders}
          description={provider?.headersConfigured ? '已有认证请求头；普通编辑会保留。' : '未保存认证请求头。'} />
      </> : null}
      {providerType !== 'inline' ? <ConfigFields
        label="规则集来源与更新"
        text={configText}
        onChange={setConfigText}
        suggestions={providerType === 'remote' ? { path: '', format: 'yaml', interval: 86400 } : { path: '', format: 'yaml' }}
      /> : null}
      {providerType !== 'inline' ? <>
        <ConfigFields label="Stash 专用参数" text={stashText} onChange={setStashText} />
        <SelectField label="Shadowrocket 专用 · 规则集交付方式"
          value={referenceType}
          onValueChange={(value) => setShadowrocketText(value === 'shared' ? '{}' : JSON.stringify({ referenceType: value }))}
          options={[
            { value: 'shared', label: '通用转换 · 服务展开规则' },
            { value: 'RULE-SET', label: '原生 RULE-SET · 设备读取引用' },
            { value: 'DOMAIN-SET', label: '原生 DOMAIN-SET · 设备读取域名列表' }
          ]} wide />
        {providerType === 'remote' && referenceType !== 'shared' ? <>
          <label className="field wide">
            <span>Shadowrocket 专用规则集地址（可选）</span>
            <input className="input mono" type="password" autoComplete="off" value={shadowrocketSourceUrl}
              disabled={clearShadowrocketSource} onChange={(event) => setShadowrocketSourceUrl(event.target.value)}
              placeholder={provider?.shadowrocketSourceConfigured ? '已保存；留空保留' : '留空使用通用地址'} />
          </label>
          <SwitchField label="清除 Shadowrocket 专用地址" checked={clearShadowrocketSource}
            onCheckedChange={setClearShadowrocketSource} description="清除后改用通用规则集地址。" />
        </> : null}
      </> : null}
    </>
  );
}
