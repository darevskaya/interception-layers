/**
 * Framework: Puppeteer
 * Protocol:  WebDriver BiDi. Puppeteer defaults to CDP for Chrome, so this
 *            example requests BiDi explicitly.
 * Browser:   Chrome
 *
 * The interception code below is identical, character for character, to the
 * CDP-based Puppeteer example. Only the launch options are different. This is
 * the point of this file: the framework API is a boundary, and the protocol
 * underneath that boundary can change without the calling code noticing.
 *
 * For Firefox, BiDi is already the default protocol, so you can omit the
 * `protocol` option.
 *
 * Run: node examples/bidi-puppeteer-intercept.js
 */
import puppeteer from 'puppeteer';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const server = await startServer();
const browser = await puppeteer.launch({ protocol: 'webDriverBiDi' });
const page = await browser.newPage();

trace.step('protocol', 'webDriverBiDi — everything below is unchanged');

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
