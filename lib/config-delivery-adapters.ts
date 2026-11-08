import { configForToken, getDeliveryStatus, getLatestConfig, readPersistedStashArtifact, revokeDownloadLink, rotateDownloadLink } from './delivery';
import { absoluteDownloadUrl, confDownload, deliveryLinks, rejectLegacyParameters, yamlDownload } from './download-response';
import {
  getLatestShadowrocketConfig, getShadowrocketStatus, readPersistedShadowrocketArtifact, revokeShadowrocketLink,
  rotateShadowrocketLink, shadowrocketConfigForToken
} from './shadowrocket-delivery';
import { materializeStashArtifact } from './managed-proxy-source';
import { getDb } from './db';
import { publicationsFor } from './target-publication-store';
import { requireAdmin } from './auth';
import { getProfileRow } from './repository-shared';
import { HttpError, jsonError, parseId } from './http';
import { configTargetIds, type ConfigDeliveryStatus, type ConfigTarget } from './config-targets';

type MaybePromise<T> = T | Promise<T>;

interface ConfigDeliveryAdapter {
  status(profileId: number): ConfigDeliveryStatus;
  adminFile(profileId: number, request: Request): MaybePromise<Response>;
  previewFile(profileId: number, request: Request): Response;
  deviceFile(token: string, request: Request): MaybePromise<Response>;
  rotate(profileId: number): MaybePromise<ConfigDeliveryStatus>;
  revoke(profileId: number): MaybePromise<void>;
}

const adapters = {
  stash: {
    status: getDeliveryStatus,
    adminFile: (profileId, request) => yamlDownload(materializeStashArtifact(getLatestConfig(profileId), request)),
    previewFile: (profileId, request) => yamlDownload(materializeStashArtifact(readPersistedStashArtifact(profileId), request)),
    deviceFile: (token, request) => yamlDownload(
      materializeStashArtifact(configForToken(token), request),
      absoluteDownloadUrl(request, new URL(request.url).pathname)
    ),
    rotate: rotateDownloadLink,
    revoke: revokeDownloadLink
  },
  shadowrocket: {
    status: getShadowrocketStatus,
    adminFile: async (profileId) => confDownload(await getLatestShadowrocketConfig(profileId)),
    previewFile: (profileId) => confDownload(readPersistedShadowrocketArtifact(profileId)),
    deviceFile: async (token) => confDownload(await shadowrocketConfigForToken(token)),
    rotate: rotateShadowrocketLink,
    revoke: revokeShadowrocketLink
  }
} satisfies Record<ConfigTarget, ConfigDeliveryAdapter>;

export function profileDeliveryTargets(request: Request, profileId: number) {
  return Object.fromEntries(configTargetIds.map((target) => [
    target, deliveryLinks(request, profileId, target, { ...adapters[target].status(profileId), publications: publicationsFor(getDb(), profileId, target) })
  ])) as Record<ConfigTarget, ConfigDeliveryStatus>;
}

export function previewDeliveredConfig(request: Request, params: { profileId: string; target: string }) {
  try {
    requireAdmin(request);
    rejectLegacyParameters(request);
    const target = configTargetIds.find(candidate => candidate === params.target);
    if (!target) throw new HttpError(404, 'Unknown client');
    const profileId = parseId(params.profileId);
    const db = getDb();
    // Bind the served artifact and managed source generations to one read snapshot.
    return db.transaction(() => {
      getProfileRow(db, profileId);
      return (adapters[target] as ConfigDeliveryAdapter).previewFile(profileId, request);
    })();
  } catch (error) {
    return jsonError(error);
  }
}

type ProfileContext = { params: Promise<{ profileId: string }> };
type DeviceContext = { params: Promise<{ token: string }> };

export function configTargetHandlers(target: ConfigTarget) {
  const adapter: ConfigDeliveryAdapter = adapters[target];
  return {
    async download(request: Request, context: ProfileContext) {
      try {
        requireAdmin(request);
        rejectLegacyParameters(request);
        return await adapter.adminFile(parseId((await context.params).profileId), request);
      } catch (error) {
        return jsonError(error);
      }
    },
    async deviceDownload(request: Request, context: DeviceContext) {
      try {
        rejectLegacyParameters(request);
        return await adapter.deviceFile((await context.params).token, request);
      } catch (error) {
        const response = jsonError(error);
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
      }
    },
    async rotate(request: Request, context: ProfileContext) {
      try {
        requireAdmin(request);
        const profileId = parseId((await context.params).profileId);
        const status = await adapter.rotate(profileId);
        return Response.json(deliveryLinks(request, profileId, target, status), {
          headers: { 'Cache-Control': 'no-store' }
        });
      } catch (error) {
        return jsonError(error);
      }
    },
    async revoke(request: Request, context: ProfileContext) {
      try {
        requireAdmin(request);
        await adapter.revoke(parseId((await context.params).profileId));
        return new Response(null, { status: 204 });
      } catch (error) {
        return jsonError(error);
      }
    }
  };
}
