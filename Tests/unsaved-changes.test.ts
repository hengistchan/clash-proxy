import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmDrafts } from '../components/unsaved-changes';

test('navigation does not prompt when all forms are saved', () => {
  assert.equal(confirmDrafts(
    [{ dirty: false, busy: false }],
    () => { assert.fail('A saved form must not ask to discard'); },
    () => { assert.fail('A saved form must not block navigation'); }
  ), true);
});

test('canceling navigation retains every unsaved form', () => {
  let discarded = 0;
  assert.equal(confirmDrafts(
    [{ dirty: true, busy: false, onDiscard: () => discarded++ }],
    () => false,
    () => { assert.fail('Idle edits do not block navigation'); }
  ), false);
  assert.equal(discarded, 0);
});

test('one confirmation discards all changed forms and leaves clean forms alone', () => {
  let prompts = 0;
  let discarded = 0;
  assert.equal(confirmDrafts(
    [
      { dirty: true, busy: false, onDiscard: () => discarded++ },
      { dirty: false, busy: false, onDiscard: () => assert.fail('Already saved') },
      { dirty: true, busy: false, onDiscard: () => discarded++ }
    ],
    () => { prompts++; return true; },
    () => { assert.fail('Idle edits do not block navigation'); }
  ), true);
  assert.equal(prompts, 1);
  assert.equal(discarded, 2);
});

test('pending writes cannot be abandoned even when another form is dirty', () => {
  let informed = 0;
  assert.equal(confirmDrafts(
    [
      { dirty: true, busy: false, onDiscard: () => assert.fail('Keep draft') },
      { dirty: false, busy: true }
    ],
    () => { assert.fail('Saving must finish before any discard prompt'); },
    () => informed++
  ), false);
  assert.equal(informed, 1);
});
