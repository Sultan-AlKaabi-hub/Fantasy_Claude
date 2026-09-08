/**
 * hud.js — in-canvas heads-up display.
 *
 * Kept deliberately sparse (Hollow Knight style): health masks, shard count,
 * dash readiness, the run timer, a zone banner on entry and a combo counter.
 * The DOM mirrors the important values in an aria-live region (see game.js)
 * so screen-reader users get the same information.
 */
import { PLAYER as P } from '../core/constants.js';
import { formatTime } from '../core/util.js';

function mask(g, x, y, filled, pulse) {
  // 8×8 "mask" shape: a soft diamond with a dark outline
  g.fillStyle = '#1a1024';
  g.fillRect(x + 2, y, 4, 1); g.fillRect(x + 1, y + 1, 6, 1); g.fillRect(x, y + 2, 8, 4); g.fillRect(x + 1, y + 6, 6, 1); g.fillRect(x + 2, y + 7, 4, 1);
  g.fillStyle = filled ? (pulse ? '#ffffff' : '#f4f1ff') : '#3a2a48';
  g.fillRect(x + 2, y + 1, 4, 1); g.fillRect(x + 1, y + 2, 6, 3); g.fillRect(x + 2, y + 5, 4, 1); g.fillRect(x + 3, y + 6, 2, 1);
  if (filled) { g.fillStyle = '#9fe8ff'; g.fillRect(x + 2, y + 2, 1, 2); }
}

export function drawHud(g, game, vw, vh, time) {
  const p = game.player;
  g.font = '8px monospace';
  g.textBaseline = 'top';

  // Health masks (top-left), respecting the safe inset passed by game.js.
  const ox = 6 + game.safeLeft, oy = 6;
  for (let i = 0; i < P.MAX_HP; i++) mask(g, ox + i * 11, oy, i < p.hp, p.flash > 0);

  // Shards
  const sx = ox, sy = oy + 12;
  g.fillStyle = '#4fd3ff'; g.fillRect(sx + 2, sy, 2, 1); g.fillRect(sx + 1, sy + 1, 4, 3); g.fillRect(sx + 2, sy + 4, 2, 2);
  g.fillStyle = '#ffffff'; g.fillRect(sx + 2, sy + 2, 1, 1);
  shadowText(g, `${game.shardCount}/${game.pickups.length}`, sx + 9, sy, '#dfe7f3');

  // Dash pip + parry hint
  const dx = sx + 40;
  const ready = p.dashAvailable && p.dashCooldown <= 0;
  g.fillStyle = ready ? '#ffe08a' : '#4a3a5a';
  g.fillRect(dx, sy + 1, 6, 4);
  if (!ready && p.dashCooldown > 0) { g.fillStyle = '#ffe08a'; g.fillRect(dx, sy + 1, Math.round(6 * (1 - p.dashCooldown / P.DASH_COOLDOWN)), 4); }
  shadowText(g, 'DASH', dx + 8, sy, ready ? '#ffe08a' : '#8a7a9a');

  // Timer (top-right)
  const t = formatTime(game.runTimeMs);
  shadowText(g, t, vw - 6 - game.safeRight - t.length * 4.8, oy, '#dfe7f3');
  if (game.profile.name) shadowText(g, game.profile.name, vw - 6 - game.safeRight - game.profile.name.length * 4.8, oy + 10, '#bfb0d8');

  // Combo counter
  if (p.comboCount > 1 && (p.state === 'attack' || p.comboWindow > 0)) {
    const s = `x${p.comboCount}`;
    g.font = '10px monospace';
    shadowText(g, s, Math.round(p.cx - game.camera.rx - 6), Math.round(p.y - game.camera.ry - 18), p.comboCount === 3 ? '#ffe08a' : '#ffffff');
    g.font = '8px monospace';
  }

  // Zone banner
  if (game.banner && game.banner.frames > 0) {
    const b = game.banner;
    const a = Math.min(1, b.frames / 20, (b.total - b.frames) / 20);
    g.globalAlpha = a;
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, vh * 0.28, vw, 26);
    g.fillStyle = '#ffe08a'; g.fillRect(0, vh * 0.28, vw, 1); g.fillRect(0, vh * 0.28 + 25, vw, 1);
    g.font = '12px monospace';
    const w = b.text.length * 7.2;
    shadowText(g, b.text, Math.round(vw / 2 - w / 2), Math.round(vh * 0.28 + 7), '#fff3c4');
    g.font = '8px monospace';
    g.globalAlpha = 1;
  }

  // Tutorial hints (first zone only, fade after use)
  if (game.hint) {
    g.globalAlpha = Math.min(1, game.hint.frames / 30);
    const w = game.hint.text.length * 4.8;
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(Math.round(vw / 2 - w / 2 - 4), vh - 22, Math.round(w + 8), 12);
    shadowText(g, game.hint.text, Math.round(vw / 2 - w / 2), vh - 20, '#dfe7f3');
    g.globalAlpha = 1;
  }

  // Low-HP heartbeat vignette is drawn by the renderer; hitstop flash too.
  void time;
}

function shadowText(g, str, x, y, col) {
  g.fillStyle = 'rgba(0,0,0,0.8)'; g.fillText(str, x + 1, y + 1);
  g.fillStyle = col; g.fillText(str, x, y);
}
