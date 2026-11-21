import { HttpError } from './http';
import { isJsonObject, type JsonObject } from './types';

function signature(value: unknown): string {
  if (!isJsonObject(value)) throw new HttpError(400, '来源请求头必须是字符串或字符串数组。');
  const entries = Object.entries(value).map(([name, item]) => {
    const values = Array.isArray(item) ? item : [item];
    if (!values.every(value => typeof value === 'string')) throw new HttpError(400, '来源请求头必须是字符串或字符串数组。');
    return [name.toLowerCase(), values] as const;
  }).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/** Store one spelling for private headers; accept Mihomo's native alias at input. */
export function canonicalSourceConfig(value: JsonObject, strict = true): JsonObject {
  const config = { ...value };
  try {
    if (config.header !== undefined && config.headers !== undefined && signature(config.header) !== signature(config.headers)) {
      throw new HttpError(400, '来源同时设置了不同的 header 和 headers，请保留其中一项。');
    }
    const headers = config.headers ?? config.header;
    if (headers !== undefined) { signature(headers); config.headers = headers; }
    delete config.header;
    return config;
  } catch (error) {
    // Existing invalid drafts must remain readable and repairable.
    if (!strict) return config;
    throw error;
  }
}

export function withoutSourceCredentials(value: JsonObject): JsonObject {
  const { url, header, headers, ...visible } = value;
  return visible;
}
