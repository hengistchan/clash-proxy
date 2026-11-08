import { createHash } from 'node:crypto';
import type { ExportResult } from './exporter';
import type { ShadowrocketArtifact } from './shadowrocket';
import { HttpError } from './http';

export function rejectLegacyParameters(request: Request) {
  const url = new URL(request.url);
  if (url.search)
    throw new HttpError(
      400,
      '下载接口不接受 URL 或模板参数，请在配置中维护各代理源。'
    );
}
export function yamlDownload(
  artifact: ExportResult & { revision: number },
  subscribedUrl?: string
) {
  const yaml = subscribedUrl
    ? `#SUBSCRIBED ${subscribedUrl}\n${artifact.yaml}`
    : artifact.yaml;
  return new Response(yaml, {
    headers: {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Config-SHA256': createHash('sha256').update(yaml).digest('hex'),
      'X-Config-Revision': String(artifact.revision),
      'X-Rule-Count': String(artifact.ruleCount)
    }
  });
}

export function confDownload(artifact: ShadowrocketArtifact & { revision: number }) {
  return new Response(artifact.conf, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Config-SHA256': artifact.sha256,
      'X-Config-Revision': String(artifact.revision),
      'X-Rule-Count': String(artifact.ruleCount)
    }
  });
}

export function absoluteDownloadUrl(
  request: Request,
  pathname: string
): string {
  const base = new URL(process.env.STASH_PUBLIC_BASE_URL || request.url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password
  ) {
    throw new HttpError(
      500,
      'STASH_PUBLIC_BASE_URL must be an HTTP/HTTPS service origin'
    );
  }
  return new URL(pathname, base.origin).toString();
}
export function deliveryLinks<T extends { subscriptionPath: string | null }>(
  request: Request,
  profileId: number,
  status: T
) {
  return {
    ...status,
    configDownloadUrl: absoluteDownloadUrl(
      request,
      `/api/profiles/${profileId}/config_download`
    ),
    subscriptionUrl: status.subscriptionPath
      ? absoluteDownloadUrl(request, status.subscriptionPath)
      : null
  };
}

export function shadowrocketDeliveryLinks<T extends { subscriptionPath: string | null }>(
  request: Request,
  profileId: number,
  status: T
) {
  return {
    ...status,
    configDownloadUrl: absoluteDownloadUrl(request, `/api/profiles/${profileId}/shadowrocket/config_download`),
    subscriptionUrl: status.subscriptionPath ? absoluteDownloadUrl(request, status.subscriptionPath) : null
  };
}
