import { z } from 'zod';
import { transaction } from './db';
import { HttpError } from './http';
import { getCompilationSnapshot, recordRevision } from './repository';
import { BUILTIN_POLICIES } from './types';

export const ruleBatchSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(10000),
  policy: z.string().trim().min(1).max(160).optional(),
  enabled: z.boolean().optional(),
  move: z.enum(['top', 'bottom', 'up', 'down']).optional()
}).strict().refine((input) => input.policy !== undefined || input.enabled !== undefined || input.move !== undefined, '请选择批量操作');

export function batchUpdateRules(profileId: number, input: z.infer<typeof ruleBatchSchema>) {
  getCompilationSnapshot(profileId);
  return transaction((db) => {
    const snapshot = getCompilationSnapshot(profileId);
    const selected = new Set(input.ids);
    const availableIds = new Set(snapshot.rules.map((rule) => rule.id));
    if (selected.size !== input.ids.length || input.ids.some((id) => !availableIds.has(id))) {
      throw new HttpError(400, '批量操作只能包含当前配置中不重复的规则 ID。');
    }
    if (input.policy !== undefined && !new Set<string>([...BUILTIN_POLICIES, ...snapshot.proxies.map((p) => p.name), ...snapshot.proxyGroups.map((g) => g.name)]).has(input.policy)) {
      throw new HttpError(400, '请选择当前配置中存在的策略目标。');
    }
    if (snapshot.rules.some((rule) => selected.has(rule.id) && rule.type === 'MATCH') && (input.enabled === false || input.move)) {
      throw new HttpError(409, 'MATCH 终位规则不能批量停用或移动。');
    }
    const setPolicy = db.prepare('UPDATE rules SET policy = ? WHERE profile_id = ? AND id = ?');
    const setEnabled = db.prepare('UPDATE rules SET enabled = ? WHERE profile_id = ? AND id = ?');
    for (const id of input.ids) {
      if (input.policy !== undefined) setPolicy.run(input.policy, profileId, id);
      if (input.enabled !== undefined) setEnabled.run(Number(input.enabled), profileId, id);
    }
    if (input.move) {
      const terminal = [...snapshot.rules].reverse().find((rule) => rule.type === 'MATCH');
      const movable = snapshot.rules.map((rule) => rule.id).filter((id) => id !== terminal?.id);
      let order = movable;
      if (input.move === 'top') order = [...movable.filter((id) => selected.has(id)), ...movable.filter((id) => !selected.has(id))];
      if (input.move === 'bottom') order = [...movable.filter((id) => !selected.has(id)), ...movable.filter((id) => selected.has(id))];
      if (input.move === 'up') for (let i = 1; i < order.length; i++) {
        if (selected.has(order[i]) && !selected.has(order[i - 1])) [order[i - 1], order[i]] = [order[i], order[i - 1]];
      }
      if (input.move === 'down') for (let i = order.length - 2; i >= 0; i--) {
        if (selected.has(order[i]) && !selected.has(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]];
      }
      if (terminal) order.push(terminal.id);
      db.prepare('UPDATE rules SET priority = priority + 1000000 WHERE profile_id = ?').run(profileId);
      const update = db.prepare('UPDATE rules SET priority = ? WHERE profile_id = ? AND id = ?');
      order.forEach((id, index) => update.run(index + 1, profileId, id));
    }
    recordRevision(db, profileId);
    const after = getCompilationSnapshot(profileId);
    return { items: after.rules, revision: after.profile.revision };
  });
}
