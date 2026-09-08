import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProfile, normalizeProfile, migrateProfile } from '../js/core/storage.js';
import { sanitizeName, formatTime } from '../js/core/util.js';
import { InputState } from '../js/core/input.js';
import { CHARACTERS, SAVE_SCHEMA } from '../js/core/constants.js';

test('normalizeProfile fills defaults for garbage input', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    const p = normalizeProfile(bad);
    assert.equal(p.schema, SAVE_SCHEMA);
    assert.equal(p.character, CHARACTERS[0].id);
    assert.deepEqual(p.run.shards, []);
    assert.equal(p.settings.touchControls, 'auto');
  }
});

test('normalizeProfile rejects hostile values but keeps valid ones', () => {
  const p = normalizeProfile({
    name: '<script>alert(1)</script> Ælfric   the Bold!!!',
    character: 'not-a-char',
    run: { checkpoint: '../../etc', shards: ['a1', 'a1', 42, 'x'.repeat(50)], kills: -5, deaths: 'lots', timeMs: NaN, bestTimeMs: 0, completed: 'yes' },
    settings: { muted: 'true', haptics: false, touchControls: 'sometimes' },
  });
  assert.equal(p.name, 'scriptalert1script Ælfric the'.slice(0, 16));
  assert.equal(p.character, CHARACTERS[0].id);
  assert.equal(p.run.checkpoint, 'start');
  assert.deepEqual(p.run.shards, ['a1']);
  assert.equal(p.run.kills, 0);
  assert.equal(p.run.deaths, 0);
  assert.equal(p.run.timeMs, 0);
  assert.equal(p.run.bestTimeMs, null);
  assert.equal(p.run.completed, false);
  assert.equal(p.settings.muted, false);
  assert.equal(p.settings.haptics, false);
  assert.equal(p.settings.touchControls, 'auto');
});

test('round-trips a valid profile unchanged', () => {
  const p = createDefaultProfile();
  p.name = 'Ysolde'; p.character = 'ember';
  p.run = { checkpoint: 'chapel', shards: ['a1', 'b2'], kills: 7, deaths: 2, timeMs: 123456, completed: true, bestTimeMs: 100000 };
  const q = normalizeProfile(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q, p);
});

test('migrateProfile stamps the current schema', () => {
  assert.equal(migrateProfile(null), null);
  assert.equal(migrateProfile({ name: 'old' }).schema, SAVE_SCHEMA);
});

test('sanitizeName keeps letters in any script and trims length', () => {
  assert.equal(sanitizeName('  Ysolde  of   Vesper '), 'Ysolde of Vesper');
  assert.equal(sanitizeName('سلطان'), 'سلطان');
  assert.equal(sanitizeName('a'.repeat(40)).length, 16);
  assert.equal(sanitizeName(null), '');
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(61_500), '1:01.5');
});

test('InputState reports press/release edges even between polls', () => {
  const s = new InputState();
  s.setDown('jump', true);
  s.setDown('jump', false);             // both inside one step
  const a = s.poll();
  assert.equal(a.pressed.jump, true);
  assert.equal(a.released.jump, true);
  assert.equal(a.held.jump, false);
  const b = s.poll();
  assert.equal(b.pressed.jump, false);
  s.setDown('left', true);
  assert.equal(s.poll().axisX, -1);
  s.setDown('right', true);
  assert.equal(s.poll().axisX, 0, 'opposing directions cancel');
  s.clear();
  assert.equal(s.poll().released.left, true);
});
