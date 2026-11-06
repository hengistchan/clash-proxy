import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUILTIN_POLICY_DESCRIPTIONS,
  PROXY_GROUP_TYPE_DESCRIPTIONS,
  RULE_TYPE_DESCRIPTIONS
} from '../lib/rule-metadata';
import { BUILTIN_POLICIES, PROXY_GROUP_TYPES, RULE_TYPES } from '../lib/types';

test('every rule, builtin policy, and group type has a non-empty explanation', () => {
  assert.equal(Object.keys(RULE_TYPE_DESCRIPTIONS).length, RULE_TYPES.length);
  assert.equal(
    Object.keys(BUILTIN_POLICY_DESCRIPTIONS).length,
    BUILTIN_POLICIES.length
  );
  assert.equal(
    Object.keys(PROXY_GROUP_TYPE_DESCRIPTIONS).length,
    PROXY_GROUP_TYPES.length
  );

  for (const value of [
    ...Object.values(RULE_TYPE_DESCRIPTIONS),
    ...Object.values(BUILTIN_POLICY_DESCRIPTIONS),
    ...Object.values(PROXY_GROUP_TYPE_DESCRIPTIONS)
  ]) {
    assert.ok(value.trim().length > 0);
  }
});
