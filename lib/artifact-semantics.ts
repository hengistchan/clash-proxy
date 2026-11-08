import { HttpError } from './http';
import { validateSubscriptionUrl } from './provider-source';
import { parseYamlDocument } from './yaml-import';

// Increment when publishing semantics change, independently from the app version.
export const CONFIG_COMPILER_VERSION = 3;

/** Old encrypted artifacts predate source-conflict validation. Never trust their old PASS flag. */
export function assertArtifactSemantics(artifact: { yaml: string; compilerVersion?: number }): void {
  if (artifact.compilerVersion === CONFIG_COMPILER_VERSION || artifact.compilerVersion === 2) return;
  try {
    const document = parseYamlDocument(artifact.yaml);
    for (const provider of document.ruleProviders) {
      if (!['domain', 'ipcidr', 'classical'].includes(provider.behavior)) throw new Error();
      if (provider.providerType === 'inline') {
        if (!['domain', 'ipcidr'].includes(provider.behavior)) throw new Error();
      } else if (provider.providerType === 'remote') {
        if (typeof provider.config.url !== 'string') throw new Error();
        validateSubscriptionUrl(provider.config.url);
      } else if (typeof provider.config.path !== 'string' || !provider.config.path.trim()) {
        throw new Error();
      }
      if (provider.config.format !== undefined && !['yaml', 'text', 'mrs'].includes(String(provider.config.format))) throw new Error();
      if (provider.config.format === 'mrs' && provider.behavior === 'classical') throw new Error();
    }
  } catch {
    // Parser errors may contain private source values. Delivery only exposes this generic message.
    throw new HttpError(409, 'The saved configuration predates current safety checks and must be repaired before delivery.');
  }
}
