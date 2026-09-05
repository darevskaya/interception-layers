/**
 * Framework: Playwright
 * Protocol:  CDP (Chrome DevTools Protocol), managed by Playwright. This
 *            example never calls CDP directly.
 * Browser:   Chromium
 *
 * This example serves the local app at http://app.invalid. This is a domain
 * with no DNS record and no hosts entry. page.route() registers a handler for
 * one URL pattern, so Playwright calls the handler only for matching requests.
 * route.fetch() produces a response object, and route.fulfill() passes that
 * response object straight through, so the example does not rebuild it by
 * hand.
 *
 * Run: node examples/playwright-route.js
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

// This line is for the trace output only. The route handler above never sees the requests that Playwright filtered out.
page.on('request', request => trace.note(`page request  ${request.method()} ${request.url()}`));

trace.step('page.route()', `${FAKE_ORIGIN}/** — matching requests only`);

await page.route(`${FAKE_ORIGIN}/**`, async route => {
  const request = route.request();
  const url = request.url();
  const localUrl = url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  trace.step('matched', `${request.method()} ${url}`);

  const response = await route.fetch({ url: localUrl });
  trace.step('fetched', `${response.status()} ${response.statusText()} <- ${localUrl}`);

  await route.fulfill({ response });
  trace.step('fulfilled', 'the response object, passed straight through');
});

await page.goto(`${FAKE_ORIGIN}/`);

// This fetch does not target the fake origin. Playwright never calls the handler for it.
await page.evaluate(url => fetch(url).catch(() => {}), `${LOCAL_ORIGIN}/api/products`);

const origin = await page.evaluate(() => location.origin);
const heading = await page.textContent('h1');

await browser.close();
await stopServer(server);

trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
