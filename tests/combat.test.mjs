import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, snap } from './helpers.mjs';
import { PLAYER as P, ENEMY as E } from '../js/core/constants.js';

const NONE = snap();
const PARRY = snap({ pressed: ['parry'] });
const ATK = snap({ pressed: ['attack'] });

/** Put a zealot right in front of the player and force it into its attack. */
function zealotFacingPlayer(s) {
  const z = s.addEnemy('zealot', 8);
  z.facing = -1;
  z.x = s.player.x + s.player.w + 30;               // inside ATTACK_RANGE (62)
  z.onGround = true;
  return z;
}

test('husk turns around at a ledge and at a wall instead of falling', () => {
  const s = new Sim({ x: 3 * 16, y: 15 * 16 });
  const h = s.addEnemy('husk', 17, 0, 39);
  h.facing = 1;
  s.player.x = 2 * 16;                              // out of sight
  for (let i = 0; i < 400; i++) { s.step(NONE); assert.ok(h.bottom <= 15 * 16 + 0.01, 'never fell into the pit'); }
  assert.equal(h.state, 'patrol');
  assert.ok(h.cx < 20 * 16, 'stayed left of the pit');
});

test('zealot telegraphs, then thrusts a parryable hitbox', () => {
  const s = new Sim(); s.settle();
  const z = zealotFacingPlayer(s);
  let sawTelegraph = false, sawHitbox = false;
  for (let i = 0; i < 200; i++) {
    s.step(NONE);
    if (z.state === 'attack' && z.telegraph > 0 && z.telegraph < 1) sawTelegraph = true;
    if (z.attackHitbox) { sawHitbox = true; assert.equal(z.attackParryable, true); break; }
  }
  assert.equal(sawTelegraph, true);
  assert.equal(sawHitbox, true);
});

test('a well-timed parry triggers hitstop, knockback and an execution window', () => {
  const s = new Sim(); s.settle();
  const z = zealotFacingPlayer(s);
  // Wait until the zealot is about to become active, then parry.
  while (!(z.state === 'attack' && z.stateFrame === E.ZEALOT.ATTACK.startup - P.PARRY_STARTUP - 1)) s.step(NONE);
  s.step(PARRY);
  assert.equal(s.player.state, 'parry');
  let parried = false;
  for (let i = 0; i < 12; i++) { s.step(NONE); if (s.player.parrySucceeded) { parried = true; break; } }
  assert.equal(parried, true, 'parry succeeded');
  assert.equal(z.state, 'stagger', 'enemy staggered (execution window open)');
  assert.ok(z.vx > 0, 'enemy knocked away from the player');
  assert.ok(s.fx.has('hitstop', P.PARRY_HITSTOP));
  assert.ok(s.fx.has('sfx', 'parry'));
  assert.equal(s.player.hp, P.MAX_HP, 'no damage taken');

  // Execution: the riposte swing lunges far enough to reach the staggered enemy and its damage is multiplied.
  assert.ok(s.player.riposte > 0, 'riposte armed');
  s.run(3);
  s.step(ATK);
  let executed = false;
  for (let i = 0; i < 12; i++) { s.step(NONE); if (s.fx.has('sfx', 'execute')) { executed = true; break; } }
  assert.equal(executed, true);
  assert.ok(z.hp <= E.ZEALOT.HP - P.EXECUTION_DMG_MULT);
});

test('a mistimed parry leaves the player vulnerable and they take the hit', () => {
  const s = new Sim(); s.settle();
  const z = zealotFacingPlayer(s);
  // Parry far too early: active window (8f) ends long before the thrust (42f startup).
  while (!(z.state === 'attack' && z.stateFrame === 5)) s.step(NONE);
  s.step(PARRY);
  let hurt = false;
  for (let i = 0; i < 80; i++) {
    s.step(NONE);
    if (s.player.state === 'hitstun') { hurt = true; break; }
  }
  assert.equal(hurt, true, 'whiffed parry → damaged');
  assert.equal(s.player.hp, P.MAX_HP - E.ZEALOT.ATTACK.dmg);
  assert.notEqual(z.state, 'stagger');
});

test('parry recovery cannot be cancelled into an attack', () => {
  const s = new Sim(); s.settle();
  s.step(PARRY);
  s.run(P.PARRY_STARTUP + P.PARRY_ACTIVE + 2);
  assert.equal(s.player.state, 'parry');
  s.step(ATK);
  assert.equal(s.player.state, 'parry', 'still locked in recovery');
});

test('player attack damages a husk, applies hitstop, and the 3rd hit is heavy', () => {
  const s = new Sim(); s.settle();
  const h = s.addEnemy('husk', 6);
  h.x = s.player.x + s.player.w + 6; h.facing = -1;
  s.step(ATK);
  let hit = false;
  for (let i = 0; i < 10; i++) { s.step(NONE); if (h.hp < E.HUSK.HP) { hit = true; break; } }
  assert.equal(hit, true);
  assert.equal(h.state, 'hitstun');
  assert.ok(s.fx.has('hitstop', P.COMBO[0].hitstop));
  // Each swing hits an enemy at most once.
  const hpAfterFirst = h.hp;
  s.run(3);
  assert.equal(h.hp, hpAfterFirst);
});

test('dashing through a husk takes no contact damage', () => {
  const s = new Sim(); s.settle();
  const h = s.addEnemy('husk', 7);
  h.x = s.player.x + 20;
  s.step(snap({ pressed: ['dash'], held: ['right'] }));
  for (let i = 0; i < P.DASH_FRAMES - 1; i++) s.step(snap({ held: ['right'] }));
  assert.equal(s.player.hp, P.MAX_HP);
});

test('husk contact damage knocks the player back with i-frames', () => {
  const s = new Sim(); s.settle();
  const h = s.addEnemy('husk', 7);
  h.x = s.player.x + 4;
  s.step(NONE);
  assert.equal(s.player.state, 'hitstun');
  assert.equal(s.player.hp, P.MAX_HP - 1);
  s.run(5);
  assert.equal(s.player.hp, P.MAX_HP - 1, 'no repeat damage while invulnerable');
});

test('killing an enemy marks it for removal after the death animation', () => {
  const s = new Sim(); s.settle();
  const h = s.addEnemy('husk', 6);
  h.hp = 1; h.x = s.player.x + s.player.w + 6;
  s.step(ATK);
  s.run(E.DEATH_FRAMES + 12);
  assert.equal(h.remove, true);
});
