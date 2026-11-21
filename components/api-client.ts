'use client';

import type { ValidationIssue } from '@/lib/types';

export class ApiError extends Error {
  status: number;
  issues: ValidationIssue[];
  code?: string;
  currentRevision?: number;

  constructor(status: number, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export const SITE_ACCESS_REQUIRED = 'forge:site-access-required';

export type ApiOptions = RequestInit & { token?: string; expectedRevision?: number };

export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
  const { token, expectedRevision, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('X-Admin-Token', token);
  if (expectedRevision !== undefined) headers.set('If-Match', `"${expectedRevision}"`);
  // Cloudflare Access can return a 401 to AJAX callers instead of redirecting.
  headers.set('X-Requested-With', 'XMLHttpRequest');
  const response = await fetch(path, {
    ...requestOptions,
    headers,
    cache: 'no-store',
    mode: 'same-origin',
    credentials: 'same-origin',
    // Treat a gateway redirect as an interruption, never follow it with API credentials.
    redirect: 'manual'
  });
  const challenge = response.headers.get('WWW-Authenticate') ?? '';
  const contentType = response.headers.get('Content-Type') ?? '';
  if (response.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(response.status) ||
    ((response.status === 401 || response.status === 403) && /\bCloudflare-Access\b/i.test(challenge)) ||
    (response.status === 401 && contentType.includes('text/html'))) {
    window.dispatchEvent(new Event(SITE_ACCESS_REQUIRED));
    // This is separate from a JSON 401 issued by the application's admin-token check.
    throw new Error('站点访问需要重新登录。');
  }
  return response;
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  let payload: unknown = null;
  if (response.status !== 204) {
    payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
  }
  if (!response.ok) {
    const detail =
      payload &&
      typeof payload === 'object' &&
      'detail' in payload &&
      typeof payload.detail === 'string'
        ? payload.detail
        : `请求失败（HTTP ${response.status}）`;
    const issues =
      payload &&
      typeof payload === 'object' &&
      'issues' in payload &&
      Array.isArray(payload.issues)
        ? (payload.issues as ValidationIssue[])
        : [];
    const error = new ApiError(response.status, detail, issues);
    if (payload && typeof payload === 'object') {
      if ('code' in payload && typeof payload.code === 'string') error.code = payload.code;
      if ('currentRevision' in payload && typeof payload.currentRevision === 'number') error.currentRevision = payload.currentRevision;
    }
    throw error;
  }
  return payload as T;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}

export function filenameFromDisposition(value: string | null): string {
  const match = value?.match(/filename="([^"]+)"/i);
  return match?.[1] || 'hj-stash.yaml';
}
