'use client';

import type { ValidationIssue } from '@/lib/types';

export class ApiError extends Error {
  status: number;
  issues: ValidationIssue[];

  constructor(status: number, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.token) {
    headers.set('X-Admin-Token', options.token);
  }
  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store'
  });
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
    throw new ApiError(response.status, detail, issues);
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
