import { z } from 'zod';
import { HttpError } from './http';
import { providerConfig } from './proxy-repository';
import { getCompilationSnapshot } from './repository';
import { proxyProviderSchema, proxyRewriteRulesSchema } from './schemas';
import { transformProxySource, validateProxyRewrites } from './proxy-source-transform';
import { downloadSource, PrivateSourceAddressError, type SourceDownload } from './upstream-download';

export const proxySourcePreviewSchema = proxyProviderSchema.pick({
  config: true, sourceUrl: true, sourceHeaders: true, clearSource: true, clearHeaders: true
}).extend({
  providerId: z.number().int().positive().optional(),
  rewriteRules: proxyRewriteRulesSchema.min(1)
});

let active = 0;
export async function previewProxySource(
  profileId: number, input: z.infer<typeof proxySourcePreviewSchema>, fetchSource: SourceDownload = downloadSource
) {
  const snapshot = getCompilationSnapshot(profileId);
  const existing = snapshot.proxyProviders.find((item) => item.id === input.providerId);
  if (input.providerId !== undefined && !existing) throw new HttpError(404, '代理源不存在。');
  validateProxyRewrites(input.rewriteRules);
  const config = providerConfig({ ...input, sourceType: 'remote' }, existing?.config);
  if (typeof config.url !== 'string' || !config.url) throw new HttpError(400, '请先填写订阅地址。');
  if (active >= 4) throw new HttpError(503, '代理源预览繁忙，请稍后再试。');
  active++;
  try {
    let body: string;
    try {
      body = await fetchSource(config, AbortSignal.timeout(12_000));
    } catch (error) {
      if (error instanceof PrivateSourceAddressError) throw new HttpError(502, '代理源解析到非公网地址，已阻止下载。');
      throw new HttpError(502, '无法下载代理源。请检查订阅地址、认证请求头或服务端网络。');
    }
    try {
      return transformProxySource(body, input.rewriteRules).preview;
    } catch {
      throw new HttpError(502, '代理源必须是包含非空 proxies 列表的 Stash / Clash YAML，且不能超过大小限制。');
    }
  } finally {
    active--;
  }
}
