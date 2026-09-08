/**
 * main.js — boot, UI wiring, PWA plumbing.
 *
 * Responsibilities
 *   • build the sprite bank and backdrops once
 *   • load the saved profile (sync peek for first paint, async confirm)
 *   • drive the title / pause / death / victory screens (all DOM, accessible)
 *   • register the service worker and surface updates + the install prompt
 *   • keep the canvas fitted and pause when the tab is hidden
 *
 * The game itself never touches these DOM screens; it emits events.
 */
import { Game } from './game.js';
import { Input } from './core/input.js';
import { AudioSystem } from './core/audio.js';
import { ProfileStore, createDefaultProfile } from './core/storage.js';
import { SpriteBank } from './render/sprites.js';
import { Backdrop } from './render/backdrop.js';
import { TitleScene } from './render/title.js';
import { CHARACTERS } from './core/constants.js';
import { sanitizeName, formatTime } from './core/util.js';
import { APP_LINKS } from './config.js';
import { encodeQR, drawQR } from './core/qr.js';

const $ = (sel) => document.querySelector(sel);

const ui = {
  stage: $('#stage'), canvas: $('#game'), touch: $('#touch'), live: $('#live'), topbar: $('#topbar'),
  title: $('#screen-title'), pause: $('#screen-pause'), dead: $('#screen-dead'), victory: $('#screen-victory'),
  form: $('#title-form'), name: $('#name-input'), charList: $('#char-list'),
  continueBlock: $('#continue-block'), continueName: $('#continue-name'), continueStats: $('#continue-stats'),
  btnContinue: $('#btn-continue'), btnNew: $('#btn-new'), btnCancelNew: $('#btn-cancel-new'),
  btnPause: $('#btn-pause'), btnResume: $('#btn-resume'), btnQuit: $('#btn-quit'),
  chkMute: $('#chk-mute'), chkMusic: $('#chk-music'), chkMusicTitle: $('#chk-music-title'), titleBg: $('#title-bg'), chkHaptics: $('#chk-haptics'), chkMotion: $('#chk-motion'), selTouch: $('#sel-touch'),
  victoryStats: $('#victory-stats'), btnAgain: $('#btn-again'), btnVictoryTitle: $('#btn-victory-title'),
  btnInstall: $('#btn-install'), btnControls: $('#btn-controls'), controlsHelp: $('#controls-help'),
  toast: $('#toast'), toastText: $('#toast-text'), toastBtn: $('#toast-btn'),
  install: $('#screen-install'), qr: $('#qr-canvas'), installStatus: $('#install-status'), btnInstallNow: $('#btn-install-now'),
  lnkAndroid: $('#lnk-android'), lnkIos: $('#lnk-ios'), iosSteps: $('#ios-steps'), androidSteps: $('#android-steps'),
  btnCopyLink: $('#btn-copy-link'), btnShareLink: $('#btn-share-link'), installUrl: $('#install-url'), btnInstallClose: $('#btn-install-close'),
};

let game, store, profile, audio, input, titleScene;
let deferredInstall = null;
// Captured before boot() strips the query string (shortcut deep links, dev flags).
const BOOT_PARAMS = new URLSearchParams(location.search);

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */
function show(screen) {
  for (const s of [ui.title, ui.pause, ui.dead, ui.victory, ui.install]) s.hidden = s !== screen;
  if (screen === ui.title) { titleScene?.fit(); titleScene?.start(); audio?.playTheme('title'); } else titleScene?.stop();
  ui.topbar.hidden = screen !== null;
  applyTouchVisibility();
  if (screen) {
    const focusable = screen.querySelector('input:not([type=radio]), button, select');
    focusable?.focus({ preventScroll: true });
  } else {
    ui.stage.focus({ preventScroll: true });
  }
}

function applyTouchVisibility() {
  const pref = profile?.settings.touchControls || 'auto';
  const coarse = matchMedia('(pointer: coarse)').matches
    || navigator.maxTouchPoints > 0
    || 'ontouchstart' in window
    || !!input?.touchUsed;
  const inGame = !!game?.running && ui.title.hidden && ui.pause.hidden && ui.victory.hidden;
  const on = pref === 'on' || (pref === 'auto' && coarse);
  ui.touch.hidden = !(on && inGame);
}

function toast(text, { action, label, ms = 6000 } = {}) {
  ui.toastText.textContent = text;
  ui.toastBtn.hidden = !action;
  ui.toastBtn.textContent = label || 'OK';
  ui.toastBtn.onclick = () => { ui.toast.hidden = true; action?.(); };
  ui.toast.hidden = false;
  if (ms) setTimeout(() => { if (ui.toastText.textContent === text) ui.toast.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ */
/* Title screen                                                        */
/* ------------------------------------------------------------------ */
function renderCharacters(bank) {
  ui.charList.textContent = '';
  CHARACTERS.forEach((ch, i) => {
    const label = document.createElement('label');
    label.className = 'char';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'character'; radio.value = ch.id; radio.checked = i === 0;
    radio.setAttribute('aria-label', `${ch.name}. ${ch.desc}`);
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32; cv.setAttribute('aria-hidden', 'true');
    cv.getContext('2d').drawImage(bank.player[ch.id].idle0, 0, 0);
    const name = document.createElement('span'); name.className = 'name'; name.textContent = ch.name;
    const desc = document.createElement('span'); desc.className = 'desc'; desc.textContent = ch.desc;
    label.append(radio, cv, name, desc);
    if (i === 0) label.classList.add('is-selected');
    radio.addEventListener('change', () => { ui.charList.querySelectorAll('.char').forEach((c) => c.classList.remove('is-selected')); label.classList.add('is-selected'); });
    ui.charList.append(label);
  });
}

function refreshTitle() {
  const hasSave = !!(profile && profile.name);
  ui.continueBlock.hidden = !hasSave;
  ui.form.hidden = hasSave;
  ui.btnCancelNew.hidden = !hasSave;
  if (hasSave) {
    ui.continueName.textContent = profile.name;
    const r = profile.run;
    const parts = [`${r.shards.length} shards`, `${r.kills} kills`, `${r.deaths} deaths`, `time ${formatTime(r.timeMs)}`];
    if (r.bestTimeMs) parts.push(`best ${formatTime(r.bestTimeMs)}`);
    ui.continueStats.textContent = parts.join(' · ');
  }
}

function startGame() {
  show(null);
  game.start(profile);
  applyTouchVisibility();
}

function onSubmitNew(e) {
  e.preventDefault();
  const name = sanitizeName(ui.name.value);
  if (!name) {
    ui.name.setAttribute('aria-invalid', 'true');
    ui.name.focus();
    toast('Please enter a name (letters and numbers).');
    return;
  }
  ui.name.removeAttribute('aria-invalid');
  const character = ui.form.querySelector('input[name=character]:checked')?.value || CHARACTERS[0].id;
  const fresh = createDefaultProfile();
  fresh.name = name;
  fresh.character = character;
  if (profile) fresh.settings = { ...profile.settings };
  profile = store.save(fresh);
  audio.unlock();
  startGame();
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
function syncSettingsUI() {
  const s = profile.settings;
  ui.chkMute.checked = s.muted;
  ui.chkMusic.checked = s.music;
  ui.chkHaptics.checked = s.haptics;
  ui.chkMotion.checked = s.reduceMotion;
  ui.selTouch.value = s.touchControls;
}
function onSettingsChange() {
  profile.settings = {
    muted: ui.chkMute.checked,
    music: ui.chkMusic.checked,
    haptics: ui.chkHaptics.checked,
    reduceMotion: ui.chkMotion.checked,
    touchControls: ui.selTouch.value,
  };
  profile = store.save(profile);
  audio.setMuted(profile.settings.muted);
  audio.setMusicEnabled(profile.settings.music);
  ui.chkMusicTitle.checked = profile.settings.music;
  game.camera.reduceMotion = profile.settings.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  applyTouchVisibility();
}

/* ------------------------------------------------------------------ */
/* PWA                                                                 */
/* ------------------------------------------------------------------ */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (BOOT_PARAMS.has('nosw')) return;   // dev escape hatch: ?nosw
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const promptReload = (worker) => {
      toast('A new version is ready.', { label: 'Reload', ms: 0, action: () => worker.postMessage({ type: 'SKIP_WAITING' }) });
    };
    if (reg.waiting && navigator.serviceWorker.controller) promptReload(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) promptReload(w);
      });
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return; refreshing = true;
      game?.save();
      location.reload();
    });
    // Check for updates when returning to the app.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  } catch (err) {
    console.warn('SW registration failed', err);
  }
}

/* ------------------------------------------------------------------ */
/* Install dialog: QR code + the right action for each platform        */
/* ------------------------------------------------------------------ */
const platform = (() => {
  const ua = navigator.userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  return { iOS, android, mobile: iOS || android, standalone, safari: iOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua) };
})();

/** The address the QR encodes: the web page (it offers the right install for every phone). */
const installUrl = () => APP_LINKS.web || location.href.split('?')[0];

let qrDrawn = false;
function drawInstallQR() {
  if (qrDrawn) return;
  try {
    const qr = encodeQR(installUrl());
    const g = ui.qr.getContext('2d');
    const cell = Math.floor(ui.qr.width / (qr.size + 8));
    const px = (qr.size + 8) * cell;
    ui.qr.width = px; ui.qr.height = px;
    drawQR(qr, g, 0, 0, cell, 4);
    qrDrawn = true;
  } catch (err) { console.warn('QR', err); ui.qr.hidden = true; }
}

function openInstallDialog() {
  drawInstallQR();
  ui.installUrl.textContent = installUrl();
  const st = ui.installStatus;
  ui.btnInstallNow.hidden = true; ui.lnkAndroid.hidden = true; ui.lnkIos.hidden = true; ui.iosSteps.hidden = true; ui.androidSteps.hidden = true;
  ui.btnShareLink.hidden = !navigator.share;

  if (platform.standalone) {
    st.textContent = 'Gloomfall is already installed on this device. Scan the code to put it on another phone.';
  } else if (platform.iOS) {
    if (APP_LINKS.ios) { ui.lnkIos.href = APP_LINKS.ios; ui.lnkIos.hidden = false; st.textContent = 'Download from the App Store:'; }
    else { st.textContent = platform.safari ? 'Add Gloomfall to your Home Screen:' : 'Open this page in Safari, then:'; ui.iosSteps.hidden = false; }
  } else if (platform.android) {
    if (APP_LINKS.android) { ui.lnkAndroid.href = APP_LINKS.android; ui.lnkAndroid.hidden = false; st.textContent = 'Download from Google Play:'; }
    else if (deferredInstall) { ui.btnInstallNow.hidden = false; st.textContent = 'Install Gloomfall as an app. It works offline and opens full-screen.'; }
    else { st.textContent = 'Install from your browser menu:'; ui.androidSteps.hidden = false; }
    if (APP_LINKS.androidApk) { ui.lnkAndroid.href = APP_LINKS.androidApk; ui.lnkAndroid.textContent = 'Download APK'; ui.lnkAndroid.hidden = false; }
  } else {
    st.textContent = 'Scan the QR code with your phone to install Gloomfall on Android or iPhone.';
    if (deferredInstall) { ui.btnInstallNow.hidden = false; ui.btnInstallNow.textContent = 'Install on this computer'; }
    if (APP_LINKS.android) { ui.lnkAndroid.href = APP_LINKS.android; ui.lnkAndroid.hidden = false; }
    if (APP_LINKS.ios) { ui.lnkIos.href = APP_LINKS.ios; ui.lnkIos.hidden = false; }
  }
  show(ui.install);
}

function wireInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  ui.btnInstall.addEventListener('click', openInstallDialog);
  ui.btnInstallClose.addEventListener('click', () => { refreshTitle(); show(ui.title); });
  ui.btnInstallNow.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    const choice = await deferredInstall.userChoice.catch(() => null);
    deferredInstall = null;
    if (choice?.outcome === 'accepted') { show(ui.title); }
    else ui.btnInstallNow.hidden = true;
  });
  ui.btnCopyLink.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(installUrl()); toast('Link copied.'); }
    catch { toast('Copy failed. The link is shown below the buttons.'); }
  });
  ui.btnShareLink.addEventListener('click', () => {
    navigator.share?.({ title: 'Gloomfall', text: 'Play Gloomfall, a dark Metroidvania that works offline.', url: installUrl() }).catch(() => {});
  });
  window.addEventListener('appinstalled', () => { toast('Installed. Gloomfall now works offline.'); if (!ui.install.hidden) show(ui.title); });
  if (platform.standalone) ui.btnInstall.textContent = 'Share / install on another phone';
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  const bank = new SpriteBank().build();
  const backdrop = new Backdrop().build();
  store = new ProfileStore();
  profile = store.peek();
  audio = new AudioSystem();
  input = new Input(ui.stage, ui.touch);
  game = new Game({ canvas: ui.canvas, stage: ui.stage, input, audio, store, bank, backdrop });

  titleScene = new TitleScene(ui.titleBg);
  audio.musicOn = profile ? profile.settings.music : true;
  ui.chkMusicTitle.checked = audio.musicOn;
  ui.chkMusicTitle.addEventListener('change', () => {
    audio.unlock();
    audio.setMusicEnabled(ui.chkMusicTitle.checked);
    if (profile) { profile.settings.music = ui.chkMusicTitle.checked; profile = store.save(profile); }
    if (ui.chkMusicTitle.checked && !ui.title.hidden) audio.playTheme('title');
  });
  renderCharacters(bank);
  refreshTitle();
  show(ui.title);

  // Authoritative async load may differ from the mirror (e.g. first run after a wipe).
  store.load().then((p) => { if (p && (!profile || p.updatedAt >= profile.updatedAt)) { profile = p; refreshTitle(); } });

  // ----- title -----
  ui.form.addEventListener('submit', onSubmitNew);
  ui.btnContinue.addEventListener('click', () => { audio.unlock(); startGame(); });
  ui.btnNew.addEventListener('click', () => { ui.continueBlock.hidden = true; ui.form.hidden = false; ui.name.value = ''; ui.name.focus(); });
  ui.btnCancelNew.addEventListener('click', () => refreshTitle());
  ui.btnControls.addEventListener('click', () => {
    const open = ui.controlsHelp.hidden;
    ui.controlsHelp.hidden = !open;
    ui.btnControls.setAttribute('aria-expanded', String(open));
  });

  // ----- pause -----
  const togglePause = () => {
    if (!game.running || game.finished) return;
    if (game.paused) { show(null); game.resume(); const z = game.currentZone; if (z) { audio.zone = null; audio.setZone(z); } }
    else { game.pause(); syncSettingsUI(); show(ui.pause); audio.stopMusic(); }
  };
  ui.btnPause.addEventListener('click', togglePause);
  ui.btnResume.addEventListener('click', togglePause);
  game.on('pauseToggle', togglePause);
  ui.btnQuit.addEventListener('click', () => { game.stop(); refreshTitle(); show(ui.title); });
  for (const el of [ui.chkMute, ui.chkHaptics, ui.chkMotion, ui.selTouch]) el.addEventListener('change', onSettingsChange);

  // ----- death / victory -----
  game.on('death', () => { ui.dead.hidden = false; });
  game.on('respawn', () => { ui.dead.hidden = true; });
  game.on('victory', (stats) => {
    ui.victoryStats.textContent = `Time ${stats.time} · best ${stats.best} · shards ${stats.shards} · kills ${stats.kills} · deaths ${stats.deaths}`;
    show(ui.victory);
  });
  ui.btnAgain.addEventListener('click', () => { game.newRun(); profile = game.profile; startGame(); });
  ui.btnVictoryTitle.addEventListener('click', () => { game.stop(); game.newRun(); profile = game.profile; refreshTitle(); show(ui.title); });
  game.on('save', (p) => { profile = p; });
  game.on('live', (msg) => { ui.live.textContent = msg; });

  // ----- environment -----
  const unlock = () => { audio.unlock(); if (!ui.title.hidden) audio.playTheme('title'); };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
  window.addEventListener('resize', () => { game.fit(); titleScene.fit(); });
  window.visualViewport?.addEventListener('resize', () => game.fit());
  screen.orientation?.addEventListener?.('change', () => setTimeout(() => { game.fit(); titleScene.fit(); }, 80));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.running && !game.paused && !game.finished) { game.pause(); syncSettingsUI(); show(ui.pause); }
    if (document.hidden) { game?.save(); audio.stopMusic(); }
    else if (!ui.title.hidden) audio.playTheme('title');
    else if (game?.running && game.currentZone) { const z = game.currentZone; audio.zone = null; audio.setZone(z); }
  });
  window.addEventListener('pagehide', () => game?.save());
  window.addEventListener('online', () => toast('Back online.'));
  window.addEventListener('offline', () => toast('You are offline. Gloomfall keeps working.'));

  // App shortcuts (manifest) & deep links.
  const action = BOOT_PARAMS.get('action');
  if (action === 'continue' && profile?.name) { /* wait for a gesture: audio needs it */ ui.btnContinue.focus(); }
  if (action === 'new') { ui.btnNew.click(); }
  if (location.search) history.replaceState(null, '', location.pathname);

  wireInstallPrompt();
  registerServiceWorker();

  // Debug / e2e hook (read-only use in tests; harmless in production).
  window.gloomfall = { game, store, audio, version: '1.0.0' };
}

boot().catch((err) => {
  console.error(err);
  toast('Something went wrong while starting. Please reload.', { ms: 0 });
});
