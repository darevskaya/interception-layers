/**
 * Framework: Puppeteer
 * Protocol:  CDP (Chrome DevTools Protocol). This is Puppeteer's default
 *            protocol for Chrome.
 * Browser:   Chrome
 *
 * This example does the same task as the Playwright example, through an API
 * with a different shape. Puppeteer switches on interception for all
 * requests, instead of registering a handler for one URL. Because of this,
 * your code must match the URL itself, and must call request.continue() for
 * every request it does not handle. Puppeteer has no equivalent to
 * route.fetch(), so this example fetches the replacement response and
 * rebuilds it by hand.
 *
 * Run: node examples/puppeteer-intercept.js
 */
import puppeteer from 'puppeteer';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const server = await startServer();
const browser = await puppeteer.launch();
const page = await browser.newPage();

await page.setRequestInterception(true);
trace.step('setRequestInterception', 'on — every request now reaches the handler');

page.on('request', async request => {
  const url = request.url();

  if (!url.startsWith(FAKE_ORIGIN)) {
    trace.note(`continue  ${request.method()} ${url}`);
    await request.continue();
    return;
  }

  const localUrl = url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  trace.step('matched', `${request.method()} ${url}`);

  const response = await fetch(localUrl, {
    method: request.method(),
    headers: request.headers(),
    body: request.postData(),
  });
  trace.step('fetched', `${response.status} ${response.statusText} <- ${localUrl}`);

  const body = Buffer.from(await response.arrayBuffer());

  await request.respond({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body,
  });
  trace.step('responded', `${body.length} B, rebuilt by hand`);
});

await page.goto(`${FAKE_ORIGIN}/`);

// This fetch does not target the fake origin, but it still reaches the handler. Puppeteer intercepts every request.
await page.evaluate(url => fetch(url).catch(() => {}), `${LOCAL_ORIGIN}/api/products`);

const origin = await page.evaluate(() => location.origin);
const heading = await page.$eval('h1', el => el.textContent);

await browser.close();
await stopServer(server);

trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
