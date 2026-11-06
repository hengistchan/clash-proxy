'use client';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { isJsonObject, type JsonObject, type JsonValue } from '@/lib/types';

type ValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
const typeLabels: Record<ValueType, string> = {
  string: '文本',
  number: '数字',
  boolean: '开关',
  object: '字段组',
  array: '列表',
  null: '空值'
};
const fieldLabels: Record<string, string> = {
  server: '服务器地址',
  port: '端口',
  url: '来源地址 / 测试地址',
  path: '文件或缓存路径',
  interval: '更新 / 检查间隔（秒）',
  enabled: '启用',
  lazy: '闲置时跳过检查',
  hidden: '在 Stash 中隐藏',
  filter: '节点名称筛选',
  tolerance: '延迟切换容差（毫秒）',
  tls: 'TLS',
  sni: 'TLS 服务器名称',
  headers: '请求头',
  hostname: '主机名',
  listen: '监听地址',
  password: '密码',
  uuid: '用户 UUID',
  timeout: '超时',
  format: '文件格式',
  strategy: '分配方式',
  force: '强制处理',
  proxies: '出口成员',
  use: '订阅来源',
  script: '脚本设置',
  shortcuts: '脚本快捷条件',
  cron: '定时任务',
  'nameserver-policy': '按域名选择 DNS',
  'fake-ip-filter': 'Fake-IP 排除项'
};
function typeOf(value: JsonValue): ValueType {
  return value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'object'
        ? 'object'
        : (typeof value as ValueType);
}
function initial(type: ValueType): JsonValue {
  return {
    string: '',
    number: 0,
    boolean: false,
    object: {},
    array: [],
    null: null
  }[type];
}
function validKey(key: string) {
  return (
    key.trim() !== '' &&
    !['__proto__', 'constructor', 'prototype'].includes(key)
  );
}
function NumberValue({
  value,
  onChange,
  label
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      className="input"
      aria-label={label}
      type="number"
      step="any"
      required
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const next = event.target.valueAsNumber;
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}
function FieldName({
  name,
  onRename
}: {
  name: string;
  onRename: (name: string) => boolean;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(name),
    [error, setError] = useState('');
  return (
    <div className="value-field-name">
      {editing ? (
        <>
          <input
            className="input"
            aria-label={`重命名 ${name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              if (onRename(draft.trim())) {
                setEditing(false);
                setError('');
              } else setError('字段名为空、已存在或不可使用。');
            }}
          >
            确定
          </button>
          <button
            type="button"
            className="text-action"
            onClick={() => {
              setEditing(false);
              setDraft(name);
              setError('');
            }}
          >
            取消
          </button>
          {error ? <small role="alert">{error}</small> : null}
        </>
      ) : (
        <>
          <strong>{fieldLabels[name] || name}</strong>
          {fieldLabels[name] ? <code>{name}</code> : null}
          <button
            type="button"
            className="text-action"
            aria-label={`重命名字段 ${name}`}
            onClick={() => setEditing(true)}
          >
            改名
          </button>
        </>
      )}
    </div>
  );
}
export function ValueFields({
  value,
  onChange,
  label,
  depth = 0,
  rootObject = false
}: {
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  label: string;
  depth?: number;
  rootObject?: boolean;
}) {
  const [newKey, setNewKey] = useState(''),
    [newType, setNewType] = useState<ValueType>('string'),
    [error, setError] = useState('');
  const [expanded, setExpanded] = useState(depth === 0);
  const type = typeOf(value);
  const typeControl = !rootObject ? (
    <select
      className="value-type"
      aria-label={`${label} 值类型`}
      value={type}
      onChange={(e) => onChange(initial(e.target.value as ValueType))}
    >
      {Object.entries(typeLabels).map(([key, text]) => (
        <option value={key} key={key}>
          {text}
        </option>
      ))}
    </select>
  ) : null;
  if (type === 'object' || type === 'array') {
    const entries =
      type === 'object'
        ? Object.entries(value as JsonObject)
        : (value as JsonValue[]).map((v, i) => [String(i), v] as const);
    return (
      <details
        className="value-container"
        open={expanded}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary>
          {label}
          <span>
            {entries.length} {type === 'array' ? '项' : '个字段'}
          </span>
        </summary>
        {expanded ? (
          <>
            <div className="value-container-tools">
              {typeControl}
              <small>按字段编辑，未知字段也会保留。</small>
            </div>
            {entries.map(([key, item], index) => (
              <div className="value-row" key={key}>
                <header>
                  {type === 'object' ? (
                    <FieldName
                      name={key}
                      onRename={(next) => {
                        if (
                          !validKey(next) ||
                          (next !== key &&
                            Object.prototype.hasOwnProperty.call(value, next))
                        )
                          return false;
                        onChange(
                          Object.fromEntries(
                            Object.entries(value as JsonObject).map(
                              ([k, v]) => [k === key ? next : k, v]
                            )
                          )
                        );
                        return true;
                      }}
                    />
                  ) : (
                    <strong>第 {index + 1} 项</strong>
                  )}
                  <div className="icon-strip">
                    {type === 'array' ? (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`${label} 第 ${index + 1} 项上移`}
                          disabled={index === 0}
                          onClick={() => {
                            const next = [...(value as JsonValue[])];
                            [next[index - 1], next[index]] = [
                              next[index],
                              next[index - 1]
                            ];
                            onChange(next);
                          }}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`${label} 第 ${index + 1} 项下移`}
                          disabled={index === entries.length - 1}
                          onClick={() => {
                            const next = [...(value as JsonValue[])];
                            [next[index + 1], next[index]] = [
                              next[index],
                              next[index + 1]
                            ];
                            onChange(next);
                          }}
                        >
                          <ArrowDown size={13} />
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`删除 ${label}.${key}`}
                      onClick={() =>
                        onChange(
                          type === 'array'
                            ? (value as JsonValue[]).filter(
                                (_, i) => i !== index
                              )
                            : Object.fromEntries(
                                Object.entries(value as JsonObject).filter(
                                  ([k]) => k !== key
                                )
                              )
                        )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </header>
                <ValueFields
                  value={item}
                  label={`${label}.${key}`}
                  depth={depth + 1}
                  onChange={(next) =>
                    onChange(
                      type === 'array'
                        ? (value as JsonValue[]).map((v, i) =>
                            i === index ? next : v
                          )
                        : { ...(value as JsonObject), [key]: next }
                    )
                  }
                />
              </div>
            ))}
            <div className="value-add">
              {type === 'object' ? (
                <input
                  className="input"
                  aria-label={`${label} 新字段名`}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="自定义字段名"
                />
              ) : null}
              <select
                className="input"
                aria-label={`${label} 新增值类型`}
                value={newType}
                onChange={(e) => setNewType(e.target.value as ValueType)}
              >
                {Object.entries(typeLabels).map(([key, text]) => (
                  <option value={key} key={key}>
                    {text}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  if (type === 'array') {
                    onChange([...(value as JsonValue[]), initial(newType)]);
                    return;
                  }
                  const key = newKey.trim();
                  if (
                    !validKey(key) ||
                    Object.prototype.hasOwnProperty.call(value, key)
                  ) {
                    setError('请输入未使用的有效字段名。');
                    return;
                  }
                  onChange({
                    ...(value as JsonObject),
                    [key]: initial(newType)
                  });
                  setNewKey('');
                  setError('');
                }}
              >
                <Plus size={13} />
                {type === 'array' ? '添加列表项' : '添加字段'}
              </button>
            </div>
            {error ? (
              <small role="alert" className="inline-error">
                {error}
              </small>
            ) : null}
          </>
        ) : null}
      </details>
    );
  }
  return (
    <div className="value-primitive">
      {type === 'boolean' ? (
        <label className="check-chip">
          <input
            type="checkbox"
            aria-label={label}
            checked={value as boolean}
            onChange={(e) => onChange(e.target.checked)}
          />
          {value ? '已启用' : '未启用'}
        </label>
      ) : type === 'number' ? (
        <NumberValue
          value={value as number}
          label={label}
          onChange={onChange}
        />
      ) : type === 'null' ? (
        <span className="delivery-note">空值</span>
      ) : String(value).includes('\n') ? (
        <textarea
          className="input value-text"
          rows={4}
          aria-label={label}
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="input"
          aria-label={label}
          type={
            /pass|secret|private.key|token|authorization|uuid/i.test(label)
              ? 'password'
              : 'text'
          }
          autoComplete="off"
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
        />
      )}{' '}
      {typeControl}
    </div>
  );
}

export function ConfigFields({
  label,
  text,
  onChange,
  objectOnly = true,
  suggestions = {}
}: {
  label: string;
  text: string;
  onChange: (text: string) => void;
  objectOnly?: boolean;
  suggestions?: Record<string, JsonValue>;
}) {
  const [expert, setExpert] = useState(false);
  let value: JsonValue = {},
    error = '';
  try {
    value = JSON.parse(text || '{}');
    if (objectOnly && !isJsonObject(value))
      error = '此处需要字段组。请在源码视图中使用一个对象。';
  } catch {
    error = '源码不是合法 JSON，请先修复后切回字段表单。';
  }
  return (
    <div className="config-fields wide">
      <div className="config-fields-head">
        <strong>{label}</strong>
        <button
          type="button"
          className="text-action"
          onClick={() => setExpert((v) => !v)}
        >
          {expert ? '切回字段表单' : '专家模式 · JSON 源码'}
        </button>
      </div>
      {expert || error ? (
        <>
          <textarea
            className="code-input"
            aria-label={`${label} JSON 源码`}
            rows={9}
            value={text}
            onChange={(e) => onChange(e.target.value)}
          />
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {isJsonObject(value) &&
          Object.keys(suggestions).some(
            (key) => !Object.prototype.hasOwnProperty.call(value, key)
          ) ? (
            <div className="preset-row">
              {Object.entries(suggestions)
                .filter(
                  ([key]) => !Object.prototype.hasOwnProperty.call(value, key)
                )
                .map(([key, initial]) => (
                  <button
                    type="button"
                    className="preset-chip"
                    key={key}
                    onClick={() =>
                      onChange(
                        JSON.stringify(
                          { ...(value as JsonObject), [key]: initial },
                          null,
                          2
                        )
                      )
                    }
                  >
                    <Plus size={12} />
                    {fieldLabels[key] || key}
                  </button>
                ))}
            </div>
          ) : null}
          <ValueFields
            value={value}
            label={label}
            rootObject={objectOnly}
            onChange={(next) => onChange(JSON.stringify(next, null, 2))}
          />
        </>
      )}
    </div>
  );
}
