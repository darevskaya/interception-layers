/**
 * Framework: Puppeteer
 * Protocol:  CDP (Puppeteer's default for Chrome)
 * Browser:   Chrome
 *
 * The same task as the Playwright example through a differently shaped API.
 * Interception is switched on globally rather than registered per URL, so both
 * the matching and the explicit request.continue() fall-through are the
 * caller's job. There is no route.fetch() equivalent either: the replacement
 * response is fetched and rebuilt by hand.
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

// Not aimed at the fake origin — it still reaches the handler anyway.
await page.evaluate(url => fetch(url).catch(() => {}), `${LOCAL_ORIGIN}/api/products`);

const origin = await page.evaluate(() => location.origin);
const heading = await page.$eval('h1', el => el.textContent);

await browser.close();
await stopServer(server);

trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
