/**
 * Framework: Puppeteer
 * Protocol:  CDP (Puppeteer's default for Chrome)
 *
 * Same task as the Playwright example: serve the local app at
 * http://app.invalid. Puppeteer exposes interception as a global toggle plus
 * a 'request' event, rather than per-URL route handlers.
 *
 * Run: node examples/puppeteer-intercept.js
 */
import puppeteer from 'puppeteer';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { note, step, verdict } from './lib/trace.js';

const server = await startServer();
const browser = await puppeteer.launch();
const page = await browser.newPage();

await page.setRequestInterception(true);
step('interception', 'on, for every request the page makes');

page.on('request', async request => {
  const url = request.url();

  // Anything not aimed at the fake origin goes through untouched.
  if (!url.startsWith(FAKE_ORIGIN)) {
    note(`continue  ${request.method()} ${url}`);
    await request.continue();
    return;
  }

  step('matched', `${request.method()} ${url}`);

  const localUrl = url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  const response = await fetch(localUrl, {
    method: request.method(),
    headers: request.headers(),
    body: request.postData(),
  });
  step('fetched', `${response.status} ${response.statusText} <- ${localUrl}`);

  const body = Buffer.from(await response.arrayBuffer());

  await request.respond({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body,
  });
  step('responded', `${body.length} B, rebuilt by hand`);
});

await page.goto(`${FAKE_ORIGIN}/`);

// One request that is not aimed at the fake origin. Unlike page.route(), it
// still reaches the handler above — the fall-through is the caller's job.
await page.evaluate(url => fetch(url).catch(() => {}), `${LOCAL_ORIGIN}/api/products`);

const origin = await page.evaluate(() => location.origin);
const heading = await page.$eval('h1', el => el.textContent);

await browser.close();
await stopServer(server);

// Reported after teardown, so a late interception cannot print past the verdict.
verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
