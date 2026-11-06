import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import type { ValidationIssue } from './types';

export class HttpError extends Error {
  status: number;
  issues?: ValidationIssue[];

  constructor(status: number, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export function jsonError(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return NextResponse.json(
      { detail: error.message, issues: error.issues || [] },
      { status: error.status }
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        detail: 'Request validation failed',
        issues: error.issues.map((issue) => ({
          severity: 'error',
          code: 'request.invalid',
          message: `${issue.path.join('.') || 'body'}: ${issue.message}`
        }))
      },
      { status: 400 }
    );
  }
  console.error('Configuration service request failed');
  return NextResponse.json(
    { detail: 'The configuration service could not complete the request.' },
    { status: 500 }
  );
}

export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, 'Request body is too large');
  }
  if (!request.body) {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'Request body is too large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

export function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'Resource identifier is invalid');
  }
  return id;
}
