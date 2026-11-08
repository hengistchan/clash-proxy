import { configForToken, getDeliveryStatus, getLatestConfig, revokeDownloadLink, rotateDownloadLink } from './delivery';
import { absoluteDownloadUrl, confDownload, deliveryLinks, rejectLegacyParameters, yamlDownload } from './download-response';
import {
  getLatestShadowrocketConfig, getShadowrocketStatus, revokeShadowrocketLink,
  rotateShadowrocketLink, shadowrocketConfigForToken
} from './shadowrocket-delivery';
import { requireAdmin } from './auth';
import { jsonError, parseId } from './http';
import { configTargetIds, type ConfigDeliveryStatus, type ConfigTarget } from './config-targets';

type MaybePromise<T> = T | Promise<T>;

interface ConfigDeliveryAdapter {
  status(profileId: number): ConfigDeliveryStatus;
  adminFile(profileId: number): MaybePromise<Response>;
  deviceFile(token: string, request: Request): MaybePromise<Response>;
  rotate(profileId: number): MaybePromise<ConfigDeliveryStatus>;
  revoke(profileId: number): MaybePromise<void>;
}

const adapters = {
  stash: {
    status: getDeliveryStatus,
    adminFile: (profileId) => yamlDownload(getLatestConfig(profileId)),
    deviceFile: (token, request) => yamlDownload(
      configForToken(token),
      absoluteDownloadUrl(request, new URL(request.url).pathname)
    ),
    rotate: rotateDownloadLink,
    revoke: revokeDownloadLink
  },
  shadowrocket: {
    status: getShadowrocketStatus,
    adminFile: async (profileId) => confDownload(await getLatestShadowrocketConfig(profileId)),
    deviceFile: async (token) => confDownload(await shadowrocketConfigForToken(token)),
    rotate: rotateShadowrocketLink,
    revoke: revokeShadowrocketLink
  }
} satisfies Record<ConfigTarget, ConfigDeliveryAdapter>;

export function profileDeliveryTargets(request: Request, profileId: number) {
  return Object.fromEntries(configTargetIds.map((target) => [
    target, deliveryLinks(request, profileId, target, adapters[target].status(profileId))
  ])) as Record<ConfigTarget, ConfigDeliveryStatus>;
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
        return await adapter.adminFile(parseId((await context.params).profileId));
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
