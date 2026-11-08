'use client';

import type { ReactNode } from 'react';
import { ConfigFields } from './config-fields';
import { SelectField, SwitchField } from './ui';

type TextChange = (text: string) => void;
type Toggle = (enabled: boolean) => void;

export function ProxyProviderFields({
  name, setName, configText, setConfigText, sourceUrl, setSourceUrl,
  sourceHeaders, setSourceHeaders, clearSource, setClearSource, clearHeaders, setClearHeaders,
  sourceType, setSourceType, sourceConfigured, rewrites
}: {
  name: string; setName: TextChange; configText: string; setConfigText: TextChange;
  sourceUrl: string; setSourceUrl: TextChange; sourceHeaders: string; setSourceHeaders: TextChange;
  clearSource: boolean; setClearSource: Toggle; clearHeaders: boolean; setClearHeaders: Toggle;
  sourceType: string; setSourceType: TextChange; sourceConfigured: boolean; rewrites: ReactNode;
}) {
  return (
    <>
      <label className="field wide">
        <span>代理源名称</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <SelectField
        label="来源方式"
        value={sourceType}
        onValueChange={setSourceType}
        options={[
          { value: 'remote', label: '远程订阅（加密保存 URL）' },
          { value: 'local', label: 'Stash 本地文件（使用 path）' }
        ]}
        wide
      />
      <label className="field wide">
        <span>私人订阅地址（HTTP/HTTPS）</span>
        <input
          className="input mono"
          type="password"
          autoComplete="new-password"
          disabled={sourceType === 'local' || clearSource}
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder={
            sourceConfigured
              ? '已有来源，留空保留；填写新地址可替换'
              : 'https://…'
          }
        />
        <small>
          加密保存到这个代理源，下载时自动使用；普通 API
          不回传地址。本地文件来源可留空，并在高级参数设置 path。
        </small>
      </label>
      <SwitchField
        label="清除已有订阅地址"
        checked={clearSource}
        onCheckedChange={setClearSource}
        description="清除后远程来源变为待配置；下载仍保留最近成功版本，直到新配置通过检查。"
      />
      <details className="wide">
        <summary>认证请求头与高级来源参数</summary>
        <ConfigFields
          label="替换认证请求头（不编辑则保留）"
          text={sourceHeaders}
          onChange={setSourceHeaders}
        />
        <SwitchField
          label="清除已有请求头"
          checked={clearHeaders}
          onCheckedChange={setClearHeaders}
        />
      </details>
      <ConfigFields
        label="来源更新与缓存"
        text={configText}
        onChange={setConfigText}
        suggestions={{ path: '', interval: 3600, filter: '' }}
      />
      {sourceType === 'remote' ? rewrites : null}
    </>
  );
}
