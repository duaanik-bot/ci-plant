import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finaliseBlock, reopenBlock } from './helpers.js';

test('finaliseBlock: allows an open, artwork-locked, not-yet-finalised card', () => {
  assert.equal(finaliseBlock({ status: 'open', finalised_at: null, artwork_locked: 1 }), null);
});

test('finaliseBlock: blocks when artwork is not locked', () => {
  assert.match(finaliseBlock({ status: 'open', finalised_at: null, artwork_locked: 0 }), /Artwork must be locked/);
});

test('finaliseBlock: blocks a closed card', () => {
  assert.match(finaliseBlock({ status: 'closed', finalised_at: null, artwork_locked: 1 }), /Closed/);
});

test('finaliseBlock: blocks an already-finalised card', () => {
  assert.match(finaliseBlock({ status: 'open', finalised_at: '2026-07-08T00:00:00Z', artwork_locked: 1 }), /already finalised/);
});

test('reopenBlock: allows a finalised card with no started stage', () => {
  assert.equal(reopenBlock({ status: 'open', finalised_at: '2026-07-08T00:00:00Z', started: false }), null);
});

test('reopenBlock: blocks when a stage has started', () => {
  assert.match(reopenBlock({ status: 'in_progress', finalised_at: '2026-07-08T00:00:00Z', started: true }), /stage has already started/);
});

test('reopenBlock: blocks a card that is not finalised', () => {
  assert.match(reopenBlock({ status: 'open', finalised_at: null, started: false }), /not finalised/);
});
