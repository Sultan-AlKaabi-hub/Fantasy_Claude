import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, snap } from './helpers.mjs';
import { PLAYER as P } from '../js/core/constants.js';

const JUMP = snap({ held: ['jump'], pressed: ['jump'] });
const HOLD_JUMP = snap({ held: ['jump'] });
const NONE = snap();

function apexHeight(sim, holdFrames) {
  const startY = sim.player.y;
  sim.step(JUMP);
  for (let i = 0; i < holdFrames - 1; i++) sim.step(HOLD_JUMP);
  let minY = sim.player.y;
  for (let i = 0; i < 60; i++) { sim.step(NONE); minY = Math.min(minY, sim.player.y); if (sim.player.onGround) break; }
  return startY - minY;
}

test('starts idle on the ground', () => {
  const s = new Sim(); s.settle();
  assert.equal(s.player.state, 'idle');
  assert.equal(s.player.onGround, true);
});

test('variable jump height: a held jump goes higher than a tapped one', () => {
  const tap = apexHeight(new Sim().settle() && new Sim(), 1);
  const s2 = new Sim(); s2.settle();
  const tapH = apexHeight(s2, 1);
  const s3 = new Sim(); s3.settle();
  const fullH = apexHeight(s3, 20);
  assert.ok(fullH > tapH * 1.8, `full ${fullH} should be much higher than tap ${tapH}`);
  assert.ok(fullH >= 50 && fullH <= 80, `full jump ~4 tiles, got ${fullH}`);
  void tap;
});

test('coyote time: can still jump a few frames after walking off a ledge', () => {
  const s = new Sim({ x: 19 * 16 + 2, y: 15 * 16 }); s.settle();
  const RIGHT = snap({ held: ['right'] });
  // Walk off the ledge into the pit (x 20–21).
  let frames = 0;
  while (s.player.onGround && frames < 60) { s.step(RIGHT); frames++; }
  assert.equal(s.player.state, 'fall');
  s.step(NONE); s.step(NONE);                       // 2 frames airborne, within the 5-frame window
  s.step(JUMP);
  assert.equal(s.player.state, 'jump', 'coyote jump allowed');
  assert.ok(s.player.vy < 0);
});

test('coyote time expires', () => {
  const s = new Sim({ x: 19 * 16 + 2, y: 15 * 16 }); s.settle();
  const RIGHT = snap({ held: ['right'] });
  while (s.player.onGround) s.step(RIGHT);
  for (let i = 0; i < P.COYOTE_FRAMES + 2; i++) s.step(NONE);
  s.step(JUMP);
  assert.notEqual(s.player.state, 'jump');
});

test('jump buffering: a press shortly before landing fires on touchdown', () => {
  const s = new Sim(); s.settle();
  s.step(JUMP);
  for (let i = 0; i < 40; i++) { s.step(NONE); if (s.player.state === 'fall' && s.player.y + s.player.h > 15 * 16 - 12) break; }
  assert.equal(s.player.state, 'fall');
  s.step(JUMP);                                     // pressed while still airborne
  let jumped = false;
  for (let i = 0; i < P.JUMP_BUFFER_FRAMES + 2; i++) { s.step(NONE); if (s.player.state === 'jump') { jumped = true; break; } }
  assert.equal(jumped, true);
});

test('dash freezes gravity, grants i-frames, and cannot be spammed', () => {
  const s = new Sim(); s.settle();
  s.step(JUMP); s.step(NONE); s.step(NONE);
  const DASH = snap({ pressed: ['dash'], held: ['right'] });
  s.step(DASH);
  assert.equal(s.player.state, 'dash');
  const y0 = s.player.y;
  assert.equal(s.player.isInvulnerable, true);
  for (let i = 0; i < 4; i++) { s.step(NONE); assert.equal(s.player.vy, 0); }
  assert.equal(s.player.y, y0, 'no vertical movement during dash');
  assert.ok(s.player.vx >= P.DASH_SPEED - 0.01);
  // Ride the dash out, then try again immediately in the air: refused (no air dash left + cooldown).
  for (let i = 0; i < P.DASH_FRAMES; i++) s.step(NONE);
  assert.notEqual(s.player.state, 'dash');
  s.step(DASH);
  assert.notEqual(s.player.state, 'dash', 'second air dash refused');
  assert.ok(s.fx.has('sfx', 'deny'));
  // Land and wait for cooldown → allowed again.
  s.run(40);
  s.step(DASH);
  assert.equal(s.player.state, 'dash');
});

test('wall slide caps fall speed and wall jump kicks away with a steer lock', () => {
  const s = new Sim({ x: 30 * 16 - 10, y: 15 * 16 }); s.settle();
  const RIGHT_JUMP = snap({ held: ['right', 'jump'], pressed: ['jump'] });
  const RIGHT = snap({ held: ['right'] });
  s.step(RIGHT_JUMP);
  for (let i = 0; i < 12; i++) s.step(snap({ held: ['right', 'jump'] }));   // full-height jump
  let slid = false;
  for (let i = 0; i < 60; i++) { s.step(RIGHT); if (s.player.state === 'wallslide') { slid = true; break; } }
  assert.equal(slid, true, 'entered wallslide against the wall at x=30');
  for (let i = 0; i < 10; i++) s.step(RIGHT);
  assert.ok(s.player.vy <= P.WALL_SLIDE_MAX + 0.01, `slide speed capped (${s.player.vy})`);
  s.step(RIGHT_JUMP);
  assert.equal(s.player.state, 'jump');
  assert.ok(s.player.vx < 0, 'pushed away from the wall');
  assert.ok(s.player.vy < 0);
  assert.equal(s.player.wallJumpLock, P.WALL_JUMP_LOCK);
  const vx = s.player.vx;
  s.step(RIGHT);                                    // holding toward the wall must be ignored during the lock
  assert.ok(s.player.vx < 0 && Math.abs(s.player.vx - vx) < 0.01);
});

test('3-hit combo chains and each swing lunges forward', () => {
  const s = new Sim(); s.settle();
  const ATK = snap({ pressed: ['attack'] });
  const x0 = s.player.x;
  s.step(ATK);
  assert.equal(s.player.state, 'attack');
  assert.equal(s.player.attackIndex, 0);
  // press during recovery to chain
  const seen = new Set([0]);
  for (let i = 0; i < 90; i++) {
    const inp = i % 9 === 8 ? ATK : NONE;
    s.step(inp);
    if (s.player.state === 'attack') seen.add(s.player.attackIndex);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
  assert.ok(s.player.x > x0 + 4, 'moved forward over the combo');
});

test('directional attacks: up anywhere, down only in the air', () => {
  const s = new Sim(); s.settle();
  s.step(snap({ pressed: ['attack'], held: ['down'] }));
  assert.equal(s.player.attackDir, 'side', 'down-attack on the ground becomes a side slash');
  const s2 = new Sim(); s2.settle();
  s2.step(JUMP); s2.step(NONE);
  s2.step(snap({ pressed: ['attack'], held: ['down'] }));
  assert.equal(s2.player.attackDir, 'down');
  const s3 = new Sim(); s3.settle();
  s3.step(snap({ pressed: ['attack'], held: ['up'] }));
  assert.equal(s3.player.attackDir, 'up');
});

test('dead is terminal: no attacking, dashing or jumping while dead', () => {
  const s = new Sim(); s.settle();
  s.player.hp = 1;
  s.player.takeDamage(s.ctx(NONE), 1, s.player.cx + 10);
  assert.equal(s.player.state, 'dead');
  s.step(snap({ pressed: ['attack', 'dash', 'jump', 'parry'], held: ['right'] }));
  assert.equal(s.player.state, 'dead');
  assert.equal(s.player.fsm.set('attack'), false);
});

test('hitstun cannot be cancelled into an attack', () => {
  const s = new Sim(); s.settle();
  s.player.takeDamage(s.ctx(NONE), 1, s.player.cx + 10);
  assert.equal(s.player.state, 'hitstun');
  assert.equal(s.player.hp, P.MAX_HP - 1);
  s.step(snap({ pressed: ['attack'] }));
  assert.equal(s.player.state, 'hitstun');
  assert.ok(s.player.invuln > 0);
});

test('spikes damage and return the player to the last safe ground', () => {
  const s = new Sim({ x: 18 * 16, y: 15 * 16 }); s.run(20);
  const RIGHT = snap({ held: ['right'] });
  for (let i = 0; i < 120; i++) { s.step(RIGHT); if (s.player.state === 'hitstun') break; }
  assert.equal(s.player.state, 'hitstun');
  assert.equal(s.player.hp, P.MAX_HP - 1);
  s.run(P.HURT_STUN + 2);
  assert.equal(s.player.bottom, 15 * 16, 'back on the floor');
  assert.ok(s.player.x + s.player.w <= 20 * 16 - 2, `fully left of the pit (x=${s.player.x})`);
  assert.ok(s.player.x + s.player.w >= 20 * 16 - 24, 'but close to where they fell');
});
