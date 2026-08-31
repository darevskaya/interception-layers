/**
 * Framework: Playwright
 * Protocol:  CDP (handled by Playwright internally)
 *
 * Serves the local app at http://app.invalid using page.route(), without
 * any DNS or hosts file entry for that domain.
 *
 * Run: node examples/playwright-route.js
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

// Intercept every request to the fake origin and answer it with the
// response fetched from the real local server.
await page.route(`${FAKE_ORIGIN}/**`, async route => {
  const localUrl = route.request().url().replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  const response = await route.fetch({ url: localUrl });

  await route.fulfill({ response });
});

await page.goto(`${FAKE_ORIGIN}/`);

// The page really believes it was served from app.invalid.
const origin = await page.evaluate(() => location.origin);
const heading = await page.textContent('h1');

console.log('origin: ', origin);
console.log('heading:', heading);
console.log(origin === FAKE_ORIGIN ? 'PASS' : 'FAIL');

await browser.close();
await stopServer(server);
