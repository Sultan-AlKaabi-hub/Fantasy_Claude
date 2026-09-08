import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelBuilder, T } from '../js/world/level.js';
import { buildWorld1 } from '../js/world/world1.js';
import { makeLevel } from './helpers.mjs';

test('falling body lands on solid ground and snaps to the tile edge', () => {
  const level = makeLevel();
  const b = { x: 40, y: 100, w: 12, h: 22, vx: 0, vy: 6 };
  let flags;
  for (let i = 0; i < 40; i++) { flags = level.moveBody(b); if (flags.ground) break; }
  assert.equal(flags.ground, true);
  assert.equal(b.y + b.h, 15 * 16);
  assert.equal(b.vy, 0);
});

test('walking into a wall stops horizontal motion and reports the side', () => {
  const level = makeLevel();
  const b = { x: 30 * 16 - 20, y: 15 * 16 - 22, w: 12, h: 22, vx: 5, vy: 0 };
  let flags;
  for (let i = 0; i < 5; i++) { b.vx = 5; flags = level.moveBody(b); }
  assert.equal(flags.right, true);
  assert.equal(b.x + b.w, 30 * 16);
});

test('one-way platform catches from above but not from below', () => {
  const level = makeLevel();
  // From above
  const a = { x: 12 * 16, y: 8 * 16, w: 12, h: 22, vx: 0, vy: 5 };
  let landed = false;
  for (let i = 0; i < 30; i++) { if (level.moveBody(a).ground) { landed = true; break; } }
  assert.equal(landed, true);
  assert.equal(a.y + a.h, 11 * 16);
  // From below: jumping up through it
  const b = { x: 12 * 16, y: 13 * 16, w: 12, h: 22, vx: 0, vy: -6 };
  let ceil = false;
  for (let i = 0; i < 12; i++) { if (level.moveBody(b).ceil) ceil = true; }
  assert.equal(ceil, false);
  assert.ok(b.y + b.h < 11 * 16, 'passed through the platform');
  // dropThrough opt-out
  const c = { x: 12 * 16, y: 11 * 16 - 22, w: 12, h: 22, vx: 0, vy: 3 };
  level.moveBody(c, { dropThrough: true });
  assert.ok(c.y + c.h > 11 * 16);
});

test('hazard detection and groundBelow', () => {
  const level = makeLevel();
  assert.equal(level.hazardIn({ x: 20 * 16, y: 17 * 16, w: 8, h: 8 }), T.SPIKE);
  assert.equal(level.hazardIn({ x: 4 * 16, y: 14 * 16, w: 8, h: 8 }), 0);
  assert.equal(level.groundBelow({ x: 4 * 16, y: 15 * 16 - 22, w: 12, h: 22 }), true);
  assert.equal(level.groundBelow({ x: 20 * 16, y: 15 * 16 - 22, w: 12, h: 22 }), false, 'pit has no ground');
});

test('builder places entities at feet coordinates', () => {
  const L = new LevelBuilder(10, 10).ground(0, 9, 8).player(3, 7).husk(5, 7, 0, 9).checkpoint('c', 6, 7).shard('s', 2, 3).build();
  assert.deepEqual(L.playerStart, { x: 3 * 16 + 8, y: 8 * 16 });
  assert.equal(L.enemies[0].y, 8 * 16);
  assert.equal(L.enemies[0].maxX, 10 * 16);
  assert.equal(L.checkpoints[0].id, 'c');
  assert.equal(L.pickups[0].id, 's');
});

test('world1 is well-formed: spawn on ground, every enemy on ground, unique ids', () => {
  const L = buildWorld1();
  const onGround = (x, y) => L.groundBelow({ x: x - 6, y: y - 22, w: 12, h: 22 });
  assert.ok(onGround(L.playerStart.x, L.playerStart.y), 'player start is grounded');
  for (const e of L.enemies) assert.ok(onGround(e.x, e.y), `enemy ${e.type} at ${e.x / 16},${e.y / 16} is grounded`);
  for (const c of L.checkpoints) assert.ok(onGround(c.x, c.y), `checkpoint ${c.id} is grounded`);
  const ids = L.pickups.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(L.goal);
  assert.equal(L.zoneAtPixel(10).id, 'market');
  assert.equal(L.zoneAtPixel(100 * 16).id, 'chapel');
  assert.equal(L.zoneAtPixel(200 * 16).id, 'keep');
});
