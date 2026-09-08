// Playwright config for the e2e smoke tests. `npm run e2e` uses npx, so no install is required.
export default {
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    viewport: { width: 900, height: 420 },
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: 'python -m http.server 8080 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8080/',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium' } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 812, height: 375 }, isMobile: true, hasTouch: true } },
  ],
};
