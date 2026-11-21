import { performance } from 'node:perf_hooks';
import { parseYamlDocument } from '../lib/yaml-import';
import { importedSnapshot, prepareImport } from '../lib/import-candidate';
import { validateSnapshot } from '../lib/validation';
import { exportProfile } from '../lib/exporter';
import { compileMihomo } from '../lib/mihomo-export';
import { compileShadowrocket } from '../lib/shadowrocket';
import type { Profile } from '../lib/types';

const profile: Profile = { id: 0, name: 'Benchmark', mode: 'rule', logLevel: 'silent', ipv6: null, settings: {}, targetPlatform: 'any', active: false, revision: 1, createdAt: '', updatedAt: '' };
for (const count of [1_000, 10_000]) {
  const stages: Record<string, number> = {};
  function measure<T>(stage: string, operation: () => T): T {
    const start = performance.now(); const value = operation(); stages[stage] = Math.round(performance.now() - start); return value;
  }
  const yaml = 'rules:\n' + Array.from({ length: count }, (_, index) => `  - DOMAIN,rule-${index}.example.test,REJECT\n`).join('') + '  - MATCH,DIRECT\n';
  const snapshot = measure('importMs', () => importedSnapshot(profile, prepareImport(undefined, 0, parseYamlDocument(yaml), undefined, 'new')));
  const validation = measure('validateMs', () => validateSnapshot(snapshot));
  if (!validation.valid) throw new Error('Benchmark fixture is invalid');
  measure('stashMs', () => exportProfile(snapshot, validation));
  if (!measure('shadowrocketMs', () => compileShadowrocket(snapshot, undefined, validation)).artifact) throw new Error('Shadowrocket benchmark did not compile');
  if (!measure('mihomoMs', () => compileMihomo(snapshot, validation)).artifact) throw new Error('Mihomo benchmark did not compile');
  console.log(JSON.stringify({ rules: count + 1, ...stages, totalMs: Object.values(stages).reduce((sum, value) => sum + value, 0), rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
}
