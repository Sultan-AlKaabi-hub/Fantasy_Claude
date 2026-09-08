# Architecture

## 1. Rendering & app model

**App shell, single page, progressive enhancement.** `index.html` is a static shell (CSP, manifest, accessible DOM screens, touch controls). The game is ES modules loaded with `<script type="module">`; there is no bundler. The shell is precached, so a repeat visit paints from cache with zero network.

Rendering is a **fixed-height low-res backbuffer** (240 px tall, 320–432 px wide depending on the display aspect) drawn with nearest-neighbour scaling to a device-pixel-ratio-aware display canvas. Fill rate is constant regardless of screen size, which is what keeps 60 FPS on low-end phones.

All art is **procedural**: sprites, tiles, decor and parallax layers are generated at boot from parametric pixel routines (`js/render/sprites.js`, `backdrop.js`). Nothing is fetched at runtime, so there is nothing to cache besides code.

## 2. Simulation

- **Fixed timestep** 60 Hz with an accumulator and a catch-up cap (`game.js`). Velocities are in px/frame; frame windows are integers.
- **Hitstop** is a global counter. Impacts request `fx.hitstop(n)`; the largest wins. While > 0, entities freeze, particles tick at ¼ speed, camera shake continues.
- **Collision** (`world/level.js`) is per-axis AABB against a tile grid with edge snapping. One-way platforms only catch bodies whose previous bottom was at or above the platform top; `down + jump` drops through.

### Player FSM (`entities/player.js`)

`idle · run · jump · fall · dash · wallslide · attack · parry · hitstun · dead`

Guard (`canTransition`): `dead` is terminal (only `Game.respawn()` → `reset()` leaves it); `hitstun` can only end in `idle | fall | dead`. Dash requires `dashAvailable && dashCooldown === 0` — restored on landing or wall contact, so there is no infinite air-dash.

| Mechanic | How |
|---|---|
| Variable jump | `JUMP_VEL` on entry; gravity × 0.5 while held (≤ 12 f); on release while rising `vy *= 0.45` |
| Coyote / buffer | `coyote` = 5 f after leaving ground; `jumpBuffer` = 5 f after a press; `tryJump()` consumes either |
| Dash | 9 f at 7 px/f, `vy = 0` every frame (gravity frozen), i-frames for the whole state, 28 f cooldown, afterimages |
| Wall slide | requires airborne, falling, pushing into a solid wall; gravity up to a 1.6 px/f cap, friction above it |
| Wall jump | `vx = -wall × 3.6`, `vy = -5.4`, 9 f steer lock; a 4-frame "stick" grace allows the jump just after leaving the wall |
| Combo | 3 swings (startup/active/recovery), each with a lunge; a press after the active frames queues the next swing; dash-cancel in recovery |
| Directional | `up` anywhere; `down` only airborne; a connecting down-slash pogos (`vy = -5`) and restores the dash |
| Parry | 2 f startup, 8 f active, 16 f recovery. Success (active frames ∧ parryable enemy hitbox overlapping): 10 f hitstop, shake, enemy `stagger` (100 f), 20 f i-frames, riposte armed. Whiff: locked for the full recovery |
| Riposte / execution | the first side-swing after a parry uses a 48 px box and a 3.4 px/f lunge; any hit on a staggered enemy is ×4 damage with 14 f hitstop |
| Hitstun | knockback, 18 f, 70 f i-frames; spikes/lava add a teleport back to the last *fully supported* ground |

### Enemy FSM (`entities/enemy.js`)

`patrol · chase · attack · hitstun · stagger · dead`

- **Husk**: patrols between bounds, turns at ledges (probes the tile ahead) and walls; chases on sight; 18 f wind-up lunge; body contact hurts.
- **Zealot**: slow patrol; chases to 62 px; 42 f telegraph (crouch, flashing spear, shout, on-screen bar), then a 10 f spear thrust (30 × 10 hitbox, parryable), 34 f recovery. Only the spear hurts.

### Combat resolution (`combat.js`)

1. player attack → enemies (once per swing per enemy), pogo check
2. enemy attack hitboxes → player: parry window is evaluated here on first overlap
3. contact damage → player

All side effects go through `ctx.fx` so the module is pure and testable.

### Camera (`core/camera.js`)

Lerp toward `player.cx + lookAhead` where lookAhead itself lerps toward `facing × 36 px`; a vertical dead-zone; bounds clamping; trauma-style shake (`shake({amp, frames})`, stacking, geometric decay) that `reduceMotion` disables.

## 3. Offline persistence

`core/storage.js`: **IndexedDB** is the durable store; **localStorage mirrors** the same JSON for a synchronous first paint and as a fallback (private mode / restricted WebViews). `navigator.storage.persist()` is requested once. Every read passes through `normalizeProfile()` which fills defaults and rejects anything off-schema, so hand-edited or corrupt data degrades to defaults. Writes are coalesced per frame; the mirror is written synchronously so a refresh mid-save loses nothing. Saves happen on checkpoint, shard pickup, pause, hide, `pagehide`, victory and quit.

Profile shape: `{ schema, id, name, character, run: { checkpoint, shards[], kills, deaths, timeMs, completed, bestTimeMs }, settings: { muted, haptics, reduceMotion, touchControls } }`.

## 4. PWA

**Manifest** (`manifest.json`): `id`, `start_url` with a `source=pwa` marker, `scope ./`, `display: standalone` with `display_override [fullscreen, standalone, minimal-ui]`, `orientation: landscape`, theme/background colours matching the shell, icons 72→512 (`any`), 192/512 (`maskable`, art inside the 80 % safe zone), a `monochrome` icon, wide + narrow **screenshots** for the richer install UI, two **shortcuts** (continue / new) that deep-link via `?action=`, `launch_handler: focus-existing`, categories. `share_target` is intentionally omitted: the game shares nothing.

**Service worker** (`sw.js`):

| Resource | Strategy | Fallback |
|---|---|---|
| Navigations | cached `index.html` (app shell), refreshed in the background | network → `offline.html` |
| Shell files (HTML, CSS, JS, manifest, icons) | precache on install, cache-first | network |
| Any other same-origin GET | stale-while-revalidate | 504 |
| Cross-origin | not intercepted (CSP forbids them anyway) | – |

Install fetches each file with `cache: 'reload'` individually so one 404 cannot abort the install. `activate` deletes old versioned caches. The page listens for `updatefound` and shows a "Reload" toast; `SKIP_WAITING` + `controllerchange` reloads after saving. Background Sync, Periodic Sync and Push are deliberately unused: there is no server.

`tools/check-precache.mjs` fails CI if a shipped file is missing from the precache list.

## 5. Performance budget

- Total transfer < 350 KB (currently ≈ 120 KB uncompressed JS + icons); no fonts, no images besides icons.
- LCP < 2.5 s on simulated slow 4G with 4× CPU slowdown (title screen is plain DOM, paints before the sprite bank builds).
- CLS 0: the canvas is sized in JS before first paint and screens are absolutely positioned.
- TBT < 200 ms: sprite/backdrop generation is ~30 ms on a mid-range phone.
- Runtime: 60 Hz fixed step, visible-tile-only rendering, pooled particles, no per-frame allocations in the hot loop beyond small objects.
- Lighthouse thresholds live in `lighthouserc.json` and run in CI as a report job.

## 6. Security

- **CSP** via `<meta http-equiv>`: `default-src 'self'`; no inline scripts; `object-src 'none'`; `base-uri 'self'`; `upgrade-insecure-requests`. Add the same policy as an HTTP header if you move off GitHub Pages.
- Secure context: SW/IndexedDB require HTTPS; GitHub Pages provides it; registration is skipped on non-secure non-localhost origins.
- **Input**: the only user text is the name → `sanitizeName()` (Unicode letters/digits/space/`'-_`, ≤ 16) and it is only ever inserted with `textContent`.
- **Stored data** is treated as hostile and normalised on read.
- Zero third-party code, so no dependency hygiene burden at runtime; dev tools are pinned versions invoked with `npx`.

## 7. Accessibility (WCAG 2.2 AA target)

- All menus are real DOM: labelled form fields, fieldset/legend for the character choice, `role="dialog"`/`aria-modal` for pause & victory, focus is moved to each screen's first control, visible 3 px focus rings, ≥ 48 px targets.
- The canvas has `role="img"` + label; an `aria-live="polite"` region mirrors health/shards/zone (throttled).
- Keyboard, gamepad and touch have full parity; controls are documented in-app.
- `prefers-reduced-motion` and an in-game toggle disable camera shake and decorative animation; `prefers-contrast: more` strengthens borders.
- Colour is never the only signal: the parry telegraph uses a bar + `!` + flash; HP uses shape fill.
- `lang`, `dir`, and a `strings`-free UI with plain sentences keep it translatable; text is not baked into sprites.

## 8. Conventions

- ES modules, no build; one concept per file; `core/` is DOM-free; `render/` is the only place that draws.
- All tuning lives in `core/constants.js`; frames are integers; velocities are px/frame.
- State machines: states are plain objects `{ enter, update, exit }`; transitions only via `fsm.set()`; guards live in `canTransition`.
- Files start with a doc comment explaining *why*; functions get JSDoc where the signature is not obvious.
- Tests are `*.test.mjs` under `tests/`, run with `node --test`; no test framework dependency.
