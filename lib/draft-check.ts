import { safeChangeLabel } from './config-diff';
import { stashTargetIssues } from './exporter';
import { compileShadowrocket } from './shadowrocket';
import { validateSnapshot } from './validation';
import type { Snapshot, ValidationIssue } from './types';
import type { ConfigTarget } from './config-targets';

export interface DraftCheck {
  state: 'ready' | 'blocked' | 'pending';
  issues: ValidationIssue[];
  servedRevision: number | null;
}

export function checkDraft(
  snapshot: Snapshot,
  served: Partial<Record<ConfigTarget, number>> = {}
): Record<ConfigTarget, DraftCheck> {
  const validation = validateSnapshot(snapshot);
  const stash = [...validation.issues, ...stashTargetIssues(snapshot)];
  const shadow = compileShadowrocket(snapshot, undefined, validation);
  const report = (target: ConfigTarget, issues: ValidationIssue[], pending: boolean): DraftCheck => ({
    state: issues.some(issue => issue.severity === 'error') ? 'blocked' : pending ? 'pending' : 'ready',
    servedRevision: served[target] ?? null,
    issues: issues.slice(0, 100).map(({ resourceId: _id, ...issue }) => ({
      ...issue,
      message: /:\/\/|(?:token|password|authorization|api[-_]?key|secret)\s*[:=]/i.test(issue.message)
        ? safeChangeLabel(issue.message) : issue.message
    }))
  });
  return {
    stash: report('stash', stash, snapshot.proxyProviders.some(item => item.rewriteRules?.length)),
    shadowrocket: report('shadowrocket', shadow.issues, shadow.sources.length > 0)
  };
}
