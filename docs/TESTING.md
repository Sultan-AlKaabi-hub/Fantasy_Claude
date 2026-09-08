# Testing

## Pyramid

| Layer | What | How | Runs |
|---|---|---|---|
| Unit | FSM, collision, player physics (coyote, buffer, variable jump, dash, wall jump, combo), combat (parry timing, execution, i-frames), enemy AI (ledge turning, telegraph), storage normalisation, input edges | `node --test tests/**/*.test.mjs` — the simulation is DOM-free, so no jsdom | every push (CI) |
| Integration | precache list matches shipped files | `node tools/check-precache.mjs` | every push |
| E2E (smoke) | boot → create pilgrim → in-game HUD → pause → reload restores profile → offline reload works | Playwright, `tests/e2e/game.spec.mjs` | on demand (`npm run e2e`) |
| Visual | screenshots of each zone in `screenshots/` are regenerated with the e2e run and diffed by eye / your favourite image diff | Playwright `toHaveScreenshot` (opt-in) | on demand |
| A11y | axe-core scan of the title and pause screens via `@axe-core/playwright`; manual keyboard-only run | e2e | on demand |
| Lighthouse | PWA installability, performance ≥ 0.9, a11y ≥ 0.95, best-practices ≥ 0.95 on simulated slow 4G + 4× CPU | `lighthouserc.json` | after deploy (report job) |
| Offline | Playwright toggles `context.setOffline(true)` after first load and reloads; DevTools "Offline" checkbox for manual checks | e2e | on demand |

## Manual checklist before a release

1. `npm run check` is green.
2. Fresh profile → name with non-Latin letters works and survives reload.
3. Install prompt appears on Chrome/Android; the app launches standalone in landscape; shortcuts work.
4. Airplane mode → relaunch → playable; progress intact.
5. Parry a Zealot with the touch buttons on a phone (feel check: hitstop, shake, riposte).
6. Update path: bump `sw.js` version → "A new version is ready" toast → Reload → new code.

## Adding a test

- Simulation tests use `tests/helpers.mjs`: `new Sim()` gives a player on a 40×20 room; `snap({held, pressed})` builds input; `sim.step()` advances one fixed frame. Assert on frames, not milliseconds.
- Never assert on random particles; assert on `fx.log` events (`fx.has('sfx', 'parry')`).
