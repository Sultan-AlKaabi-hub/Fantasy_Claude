# Deploy checklist: GitHub Pages → median.co

Follow these steps in order. Nothing needs to be built; the repository *is* the site.

## 1. Push to GitHub

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

(The repo already has an initial commit on `main`.)

## 2. Turn on GitHub Pages

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab. The workflow "Deploy to GitHub Pages" runs on every push to `main`. The first run takes about a minute.
4. When it is green, the site is live at `https://<you>.github.io/<repo>/`.

What the workflow does: runs the unit tests, checks the service-worker precache list, stamps `sw.js` with the commit hash (so every deploy replaces the old cache), and publishes the files.

## 3. Check the PWA in a browser

1. Open the URL on your phone in Chrome (Android) or Safari (iOS).
2. Play for a few seconds, then turn on Airplane mode and reload. The game must still load.
3. Chrome shows **Install app** on the title screen; iOS uses **Share → Add to Home Screen**.

## 4. Wrap with median.co

1. Go to <https://median.co> → **Create app**.
2. Paste the Pages URL as the **Website URL**.
3. Suggested settings:
   - **App name**: Gloomfall · **Bundle ID**: your choice.
   - **Orientation**: Auto / all orientations (matches `"orientation": "any"` in `manifest.json`; the layout adapts to portrait and landscape).
   - **Status bar**: hidden or dark.
   - **Icons / splash**: upload `icons/icon-512.png` and `icons/maskable-512.png`; splash background `#0b0912`.
   - **Offline**: leave the default. The site's own service worker already caches everything.
   - **Native navigation / tabs**: off (the game handles its own UI).
   - **Keep screen on / prevent sleep**: on.
   - **Haptics** are provided by the web `navigator.vibrate` API on Android; iOS WebView ignores it silently.
4. Build the Android APK / iOS project from median's dashboard and test on a device.

## 5. Updating the game later

Push to `main`. Pages redeploys, the service worker notices the new version, and players see "A new version is ready — Reload" the next time they open the app. The median wrapper needs no rebuild because it loads the live site.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Blank page on Pages | Check the Actions tab for a failed test; the deploy is skipped when tests fail. |
| Old version keeps showing | Hard-reload once, or wait for the "Reload" toast. Every deploy has a new cache name. |
| Touch controls missing | Pause → **Touch controls** → **Always on**. Auto mode shows them on any touchscreen. |
| No sound on iOS | Sound starts after the first tap (browser rule). Also check the mute toggle in Pause. |

## Mobile compatibility (checked)

| Area | iOS Safari / WKWebView (median) | Android Chrome / WebView (median) |
|---|---|---|
| Minimum version | iOS 14+ (optional chaining, `\p{L}` regex, pointer events) | Chrome 80+ / WebView 80+ |
| Touch controls | Pointer events with capture; `touch-action: none` on pads; long-press callout and double-tap zoom disabled | Same code path; 5-point multitouch tested in emulation |
| Audio & music | Starts after the first tap (WebAudio rule); resumes on return from background | Same |
| Vibration | Not supported by iOS; call is skipped silently | `navigator.vibrate` after the first tap |
| Saves offline | IndexedDB + localStorage mirror; private mode falls back to memory + mirror | IndexedDB + mirror |
| Rotation | `orientation: any`; layout re-fits on `orientationchange` and `visualViewport` resize; safe-area insets respected | Same |
| Install | Share → Add to Home Screen (`apple-mobile-web-app-capable`) | Install prompt on the title screen |
| Offline | Service worker precaches the whole app on first load | Same |
