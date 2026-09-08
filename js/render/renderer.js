/**
 * renderer.js — draws one frame of the world into the low-res backbuffer.
 *
 * Draw order (back → front):
 *   sky + parallax (crossfaded between zones) → tiles → background decor →
 *   pickups / shrines / gate → enemies → dash ghosts → player → attack fx →
 *   particles → floating text → screen flash / vignette → HUD (hud.js)
 *
 * Only tiles inside the camera rectangle are touched, so cost is independent
 * of level size. The backbuffer is then scaled to the display canvas with
 * nearest-neighbour filtering by game.js.
 */
import { TILE, PLAYER as P, ENEMY as E } from '../core/constants.js';
import { T, ZONES } from '../world/level.js';
import { ZONE_PAL } from './sprites.js';
import { drawHud } from './hud.js';

const ZONE_BLEND_PX = 160;

export class Renderer {
  constructor(bank, backdrop) {
    this.bank = bank;
    this.backdrop = backdrop;
    this.time = 0;
    this.flashCol = null; this.flashA = 0;
    this.buf = document.createElement('canvas');
    this.g = this.buf.getContext('2d', { alpha: false });
    this.resize(384, 240);
  }

  resize(w, h) {
    this.buf.width = w; this.buf.height = h;
    this.g.imageSmoothingEnabled = false;
    this.g.font = '8px monospace';
  }

  flash(col, a) { this.flashCol = col; this.flashA = a; }

  /** Which zones are visible and how much of each (for crossfading). */
  zoneMix(camX, vw) {
    const mid = camX + vw / 2;
    const out = [];
    for (let i = 0; i < ZONES.length; i++) {
      const z = ZONES[i];
      const x0 = z.from * TILE, x1 = (z.to + 1) * TILE;
      let a = 0;
      if (mid >= x0 && mid < x1) a = 1;
      else if (mid < x0 && x0 - mid < ZONE_BLEND_PX) a = 1 - (x0 - mid) / ZONE_BLEND_PX;
      else if (mid >= x1 && mid - x1 < ZONE_BLEND_PX) a = 1 - (mid - x1) / ZONE_BLEND_PX;
      if (a > 0) out.push({ id: z.id, a });
    }
    return out;
  }

  render(game) {
    const g = this.g, vw = this.buf.width, vh = this.buf.height;
    const { level, player, enemies, particles, camera } = game;
    const cx = camera.rx, cy = camera.ry;
    this.time++;

    // ---- sky & parallax ----
    const mix = this.zoneMix(camera.x, vw);
    mix.sort((a, b) => a.a - b.a);
    if (mix.length === 0) { g.fillStyle = '#000'; g.fillRect(0, 0, vw, vh); }
    for (let i = 0; i < mix.length; i++) this.backdrop.draw(g, mix[i].id, cx, cy, vw, vh, i === 0 ? 1 : mix[i].a, this.time);

    // ---- tiles ----
    const tx0 = Math.max(0, Math.floor(cx / TILE)), tx1 = Math.min(level.w - 1, Math.floor((cx + vw) / TILE));
    const ty0 = Math.max(0, Math.floor(cy / TILE)), ty1 = Math.min(level.h - 1, Math.floor((cy + vh) / TILE));
    const liquidFrame = Math.floor(this.time / 10) % 3;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = level.get(tx, ty);
        if (id === T.EMPTY) continue;
        const zone = level.zoneAtPixel(tx * TILE).id;
        const set = this.bank.tiles[zone];
        const dx = tx * TILE - cx, dy = ty * TILE - cy;
        if (id === T.SOLID) {
          const above = level.get(tx, ty - 1);
          const top = above !== T.SOLID;
          const v = (tx * 7 + ty * 13) & 3;
          g.drawImage(top ? set.solidTop[v] : set.solid[v], dx, dy);
          // subtle inner shadow one tile under the surface
          if (top) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(dx, dy + TILE, TILE, 3); }
        } else if (id === T.PLATFORM) {
          g.drawImage(set.platform, dx, dy);
        } else if (id === T.SPIKE) {
          g.drawImage(set.spike, dx, dy);
        } else if (id === T.HAZARD) {
          const top = level.get(tx, ty - 1) !== T.HAZARD;
          g.drawImage(top ? set.liquidTop[liquidFrame] : set.liquid[liquidFrame], dx, dy);
        }
      }
    }
    // hazard glow (lava lights the keep; water shimmers)
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (level.get(tx, ty) === T.HAZARD && level.get(tx, ty - 1) !== T.HAZARD) {
          const zone = level.zoneAtPixel(tx * TILE).id;
          g.fillStyle = zone === 'keep' ? 'rgba(255,120,40,0.18)' : 'rgba(120,180,255,0.12)';
          g.fillRect(tx * TILE - cx, ty * TILE - cy - 12, TILE, 12);
        }
      }
    }

    // ---- decor ----
    for (const d of level.decor) {
      if (d.x + 64 < cx || d.x - 16 > cx + vw) continue;
      const zone = level.zoneAtPixel(d.x).id;
      const frames = this.bank.decor[zone][d.type];
      if (!frames) continue;
      const img = frames[Math.floor(this.time / 14) % frames.length];
      const x = d.x - cx, y = d.y - img.height - cy;
      if (d.flip) { g.save(); g.translate(x + img.width, y); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); }
      else g.drawImage(img, x, y);
      if (d.type === 'lantern') { g.fillStyle = 'rgba(255,200,90,0.14)'; g.beginPath(); g.arc(x + 8, y + 9, 20 + Math.sin(this.time / 9), 0, Math.PI * 2); g.fill(); }
    }

    // ---- checkpoints, pickups, gate ----
    for (const c of game.checkpoints) {
      const zone = level.zoneAtPixel(c.x).id;
      const img = this.bank.decor[zone].shrine[c.id === game.activeCheckpoint ? 1 : 0];
      g.drawImage(img, Math.round(c.x - 12 - cx), Math.round(c.y - 32 - cy));
      if (c.id === game.activeCheckpoint) { g.fillStyle = 'rgba(255,224,138,0.12)'; g.beginPath(); g.arc(c.x - cx, c.y - 18 - cy, 22 + Math.sin(this.time / 7) * 2, 0, Math.PI * 2); g.fill(); }
    }
    for (const s of game.pickups) {
      if (s.taken) continue;
      const zone = level.zoneAtPixel(s.x).id;
      const bob = Math.sin((this.time + s.x) / 12) * 2;
      g.drawImage(this.bank.decor[zone].shard[Math.floor(this.time / 8) % 2], Math.round(s.x - 6 - cx), Math.round(s.y - 6 + bob - cy));
    }
    if (level.goal) {
      const zone = level.zoneAtPixel(level.goal.x).id;
      g.drawImage(this.bank.decor[zone].gate[Math.floor(this.time / 10) % 2], level.goal.x - cx, level.goal.y + level.goal.h - 48 - cy);
    }

    // ---- enemies ----
    for (const e of enemies) this.drawEnemy(g, e, cx, cy);

    // ---- dash ghosts ----
    for (const gh of particles.ghosts) {
      g.globalAlpha = (gh.life / gh.max) * 0.45;
      this.blit(g, gh.sprite, gh.x + 6 - 16 - cx, gh.y + 22 - 30 - cy, gh.facing);
    }
    g.globalAlpha = 1;

    // ---- player ----
    if (!(player.invuln > 0 && !player.isDead && player.state !== 'parry' && Math.floor(this.time / 3) % 2 === 0 && player.state !== 'hitstun')) {
      const chSet = this.bank.player[game.profile.character];
      const pose = playerPose(player);
      const img = player.flash > 0 ? chSet.__flash[pose] : chSet[pose];
      this.blit(g, img, Math.round(player.x + player.w / 2 - 16 - cx), Math.round(player.bottom - 30 - cy), player.facing);
      this.drawPlayerFx(g, player, cx, cy);
    }

    // ---- particles ----
    for (const p of particles.items) {
      g.globalAlpha = Math.min(1, p.life / 8);
      g.fillStyle = p.col;
      g.fillRect(Math.round(p.x - cx), Math.round(p.y - cy), p.size, p.size);
    }
    g.globalAlpha = 1;
    for (const t of particles.texts) {
      g.globalAlpha = Math.min(1, t.life / 10);
      g.fillStyle = '#000'; g.fillText(t.str, Math.round(t.x - cx - t.str.length * 2.4) + 1, Math.round(t.y - cy) + 1);
      g.fillStyle = t.col; g.fillText(t.str, Math.round(t.x - cx - t.str.length * 2.4), Math.round(t.y - cy));
    }
    g.globalAlpha = 1;

    // ---- vignette & flash ----
    const vg = g.createRadialGradient(vw / 2, vh / 2, vh * 0.45, vw / 2, vh / 2, vh * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,5,20,0.45)');
    g.fillStyle = vg; g.fillRect(0, 0, vw, vh);
    if (game.hitstop > 0 && !player.isDead) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, 0, vw, vh); }
    if (this.flashA > 0.01) {
      g.globalAlpha = this.flashA; g.fillStyle = this.flashCol; g.fillRect(0, 0, vw, vh); g.globalAlpha = 1;
      this.flashA *= 0.82;
    }
    if (player.hp <= 1 && !player.isDead) {
      g.fillStyle = `rgba(200,20,40,${0.08 + Math.sin(this.time / 10) * 0.05})`; g.fillRect(0, 0, vw, vh);
    }

    drawHud(g, game, vw, vh, this.time);
  }

  /** Draw a sprite mirrored when facing left. */
  blit(g, img, x, y, facing) {
    if (facing >= 0) { g.drawImage(img, x, y); return; }
    g.save(); g.translate(x + img.width, y); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore();
  }

  drawPlayerFx(g, p, cx, cy) {
    // Slash crescent on active frames.
    const hb = p.attackHitbox;
    if (hb) {
      const swing = P.COMBO[p.attackIndex];
      const t = (p.stateFrame - swing.startup) / swing.active;
      g.save();
      g.strokeStyle = p.attackIndex === 2 ? '#ffe08a' : '#ffffff';
      g.lineWidth = p.attackIndex === 2 ? 2 : 1;
      g.globalAlpha = 1 - t * 0.6;
      const ox = hb.x + hb.w / 2 - cx, oy = hb.y + hb.h / 2 - cy;
      const r = Math.max(hb.w, hb.h) / 2 + 2;
      let a0, a1;
      if (p.attackDir === 'up') { a0 = -Math.PI * 0.9; a1 = -Math.PI * 0.1; }
      else if (p.attackDir === 'down') { a0 = Math.PI * 0.1; a1 = Math.PI * 0.9; }
      else if (p.facing > 0) { a0 = -Math.PI * 0.45 + t * 0.4; a1 = Math.PI * 0.45 + t * 0.4; }
      else { a0 = Math.PI * 0.55 + t * 0.4; a1 = Math.PI * 1.45 + t * 0.4; }
      g.beginPath(); g.arc(ox, oy, r, a0, a1); g.stroke();
      g.globalAlpha *= 0.5; g.beginPath(); g.arc(ox, oy, r - 3, a0, a1); g.stroke();
      g.restore();
    }
    // Parry window glint.
    if (p.parryActive) {
      const x = (p.facing > 0 ? p.x + p.w + 4 : p.x - 4) - cx, y = p.cy - cy;
      g.fillStyle = '#ffe08a'; g.fillRect(x - 1, y - 6, 2, 12);
      g.fillStyle = '#ffffff'; g.fillRect(x - 3 + (p.facing > 0 ? 2 : 0), y - 1, 3, 2);
    }
    if (p.state === 'parry' && p.parrySucceeded) {
      g.strokeStyle = '#ffe08a'; g.globalAlpha = 0.7;
      g.beginPath(); g.arc(p.cx - cx, p.cy - cy, 14 + p.stateFrame, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
  }

  drawEnemy(g, e, cx, cy) {
    const isZ = e.type === 'zealot';
    const set = isZ ? this.bank.zealot : this.bank.husk;
    const fset = isZ ? this.bank.zealotFlash : this.bank.huskFlash;
    const pose = enemyPose(e);
    const img = e.flash > 0 ? fset[pose] : set[pose];
    const w = img.width, h = img.height;
    let x = Math.round(e.cx - w / 2 - cx), y = Math.round(e.bottom - (isZ ? 27 : 19) - cy);
    if (isZ) x += e.facing > 0 ? 4 : -4;   // sprite canvas is wider on the spear side
    if (e.state === 'stagger') x += Math.round(Math.sin(e.stateFrame * 0.8)) * 1;
    if (e.state === 'dead') g.globalAlpha = Math.max(0, 1 - e.stateFrame / E.DEATH_FRAMES);
    this.blit(g, img, x, y, e.facing);
    g.globalAlpha = 1;

    // Telegraph: exclamation + growing bar so the parry timing is readable.
    if (e.state === 'attack' && e.telegraph > 0 && e.telegraph < 1) {
      const t = e.telegraph;
      const px = Math.round(e.cx - cx), py = Math.round(e.y - 10 - cy);
      g.fillStyle = t > 0.75 && Math.floor(this.time / 2) % 2 ? '#ffffff' : (isZ ? '#ff2e4c' : '#ffb347');
      g.fillRect(px - 1, py - 8, 2, 6); g.fillRect(px - 1, py, 2, 2);
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(px - 8, py + 4, 16, 2);
      g.fillStyle = isZ ? '#ff2e4c' : '#ffb347'; g.fillRect(px - 8, py + 4, Math.round(16 * t), 2);
    }
    if (e.state === 'stagger') {
      const px = Math.round(e.cx - cx), py = Math.round(e.y - 12 - cy);
      g.fillStyle = Math.floor(this.time / 4) % 2 ? '#ffe08a' : '#ffffff';
      g.fillText('!', px - 2, py); g.fillText('!', px - 6, py - 3); g.fillText('!', px + 3, py - 3);
    }
    // HP pips once damaged
    if (e.hp < e.maxHp && e.state !== 'dead') {
      const px = Math.round(e.cx - e.maxHp * 2 - cx), py = Math.round(e.y - 5 - cy);
      for (let i = 0; i < e.maxHp; i++) { g.fillStyle = i < e.hp ? '#ff4d6d' : '#3a1020'; g.fillRect(px + i * 4, py, 3, 2); }
    }
  }
}

/* ------------------------------------------------------------------ */
function playerPose(p) {
  const f = p.stateFrame;
  switch (p.state) {
    case 'idle': return f % 48 < 24 ? 'idle0' : 'idle1';
    case 'run': return `run${Math.floor(f / 5) % 4}`;
    case 'jump': return 'jump';
    case 'fall': return 'fall';
    case 'dash': return 'dash';
    case 'wallslide': return 'wall';
    case 'attack': {
      if (p.attackDir === 'up') return 'atkUp';
      if (p.attackDir === 'down') return 'atkDown';
      const swing = P.COMBO[p.attackIndex];
      return f < swing.startup ? `atk${p.attackIndex}a` : `atk${p.attackIndex}b`;
    }
    case 'parry': return p.parrySucceeded ? 'parryOk' : 'parry';
    case 'hitstun': return 'hurt';
    case 'dead': return 'dead';
    default: return 'idle0';
  }
}

function enemyPose(e) {
  const f = e.stateFrame;
  const a = e.cfg.ATTACK;
  if (e.type === 'husk') {
    switch (e.state) {
      case 'patrol': return f % 24 < 12 ? 'walk0' : 'walk1';
      case 'chase': return f % 12 < 6 ? 'walk0' : 'walk1';
      case 'attack': return f < a.startup ? 'wind' : f < a.startup + a.active ? 'lunge' : 'walk0';
      case 'hitstun': case 'stagger': return 'hurt';
      case 'dead': return 'dead';
      default: return 'walk0';
    }
  }
  switch (e.state) {
    case 'patrol': return f % 32 < 16 ? 'walk0' : 'walk1';
    case 'chase': return f % 16 < 8 ? 'walk0' : 'walk1';
    case 'attack':
      if (f < a.startup) { const rate = e.telegraph > 0.7 ? 2 : 6; return Math.floor(f / rate) % 2 ? 'charge1' : 'charge0'; }
      return f < a.startup + a.active ? 'thrust' : 'recover';
    case 'hitstun': return 'hurt';
    case 'stagger': return 'stagger';
    case 'dead': return 'dead';
    default: return 'idle';
  }
}

export { ZONE_PAL };
