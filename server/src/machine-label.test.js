import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineLabel } from '../../client/src/lib/pastingRows.js';

// A shortening rule is only safe if it cannot shorten a name into nothing. These
// are the live pasting machines, plus the cases that would break the rule.

test('the live pasting machines', () => {
  assert.equal(machineLabel('Automatic Lock Bottom Pasting Machine'), 'Automatic Lock Bottom');
  assert.equal(machineLabel('Side Pasting Machine'), 'Side Pasting');
  assert.equal(machineLabel('Manual Pasting'), 'Manual Pasting');
});

test('never strips a name down to one word', () => {
  // "Side Pasting Machine" reduced all the way is "Side", which names nothing.
  assert.equal(machineLabel('Side Machine'), 'Side Machine');
  assert.equal(machineLabel('Pasting Machine'), 'Pasting Machine');
  assert.equal(machineLabel('Machine'), 'Machine');
});

test('only a TRAILING noise word goes', () => {
  assert.equal(machineLabel('Machine Shop Folder Gluer'), 'Machine Shop Folder Gluer');
  assert.equal(machineLabel('Pasting Line Two Bench'), 'Pasting Line Two Bench');
});

test('a name carrying neither word is untouched', () => {
  assert.equal(machineLabel('Bobst Folder Gluer 110'), 'Bobst Folder Gluer 110');
});

test('whitespace and nothing at all', () => {
  assert.equal(machineLabel('  Side   Pasting   Machine '), 'Side Pasting');
  assert.equal(machineLabel(''), '');
  assert.equal(machineLabel(null), '');
  assert.equal(machineLabel(undefined), '');
});
