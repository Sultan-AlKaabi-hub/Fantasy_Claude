/**
 * combat.js — resolves every hit interaction for one fixed step.
 *
 * Order matters and is deliberate:
 *   1. Player attack → enemies   (so a trade is possible on the same frame)
 *   2. Enemy attack → player     (parry is checked here: active parry frames
 *                                 vs. a parryable hitbox on first overlap)
 *   3. Body contact → player     (Husk-style touch damage; never parryable)
 *
 * All side effects (hitstop, shake, sfx, particles) go through ctx.fx so this
 * module stays pure and unit-testable with a stub sink.
 */
import { aabb } from './core/util.js';
import { PLAYER as P } from './core/constants.js';
import { T } from './world/level.js';

export function resolveCombat(ctx, player, enemies) {
  if (player.isDead) return;

  // 1. Player attack vs enemies
  const hb = player.attackHitbox;
  if (hb) {
    let landed = false;
    for (const e of enemies) {
      if (e.isDead || player.attackHits.has(e)) continue;
      if (!aabb(hb, e.box)) continue;
      player.attackHits.add(e);
      const heavy = player.attackIndex === P.COMBO.length - 1;
      if (e.takeHit(ctx, player.attackDamage, player.cx, { hitstop: player.attackHitstop, heavy })) landed = true;
    }
    // Pogo: a downward slash that connects with anything bounces the player.
    if (player.attackDir === 'down' && !player.pogoed) {
      const spiked = ctx.level.hazardIn(hb) === T.SPIKE;
      if (landed || spiked) {
        player.vy = P.POGO_VY;
        player.dashAvailable = true;
        player.pogoed = true;
        ctx.fx.sfx('pogo');
        if (spiked) ctx.fx.burst('spark', player.cx, player.bottom + 6, 0);
      }
    }
  } else {
    player.pogoed = false;
  }

  // 2. Enemy attacks vs player (parry window lives here)
  for (const e of enemies) {
    const ab = e.attackHitbox;
    if (!ab || !aabb(ab, player.box)) continue;
    if (player.parryActive && e.attackParryable) {
      player.onParrySuccess(ctx);
      e.onParried(ctx, player.cx);
      continue;
    }
    player.takeDamage(ctx, e.attackDamage, e.cx);
    if (player.isDead) return;
  }

  // 3. Contact damage
  for (const e of enemies) {
    const dmg = e.contactDamage;
    if (dmg <= 0 || !aabb(e.box, player.box)) continue;
    player.takeDamage(ctx, dmg, e.cx);
    if (player.isDead) return;
  }
}
