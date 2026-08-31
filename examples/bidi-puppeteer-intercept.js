/**
 * Framework: Puppeteer
 * Protocol:  WebDriver BiDi (Puppeteer defaults to CDP for Chrome, so it is
 *            requested explicitly here)
 *
 * The interception code below is character-for-character the same as the
 * CDP-based Puppeteer example. Only the launch options differ. That is the
 * point of this file: the framework API is the boundary, and the protocol
 * underneath it can change without the calling code noticing.
 *
 * For Firefox, BiDi is already the default and `protocol` can be omitted.
 *
 * Run: node examples/bidi-puppeteer-intercept.js
 */
import puppeteer from 'puppeteer';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';

const server = await startServer();

const browser = await puppeteer.launch({
  browser: 'chrome',
  protocol: 'webDriverBiDi',
});

const page = await browser.newPage();

await page.setRequestInterception(true);

page.on('request', async request => {
  const url = request.url();

  // Anything not aimed at the fake origin goes through untouched.
  if (!url.startsWith(FAKE_ORIGIN)) {
    await request.continue();
    return;
  }

  const localUrl = url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  const response = await fetch(localUrl, {
    method: request.method(),
    headers: request.headers(),
    body: request.postData(),
  });

  await request.respond({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  });
});

await page.goto(`${FAKE_ORIGIN}/`);

const origin = await page.evaluate(() => location.origin);
const heading = await page.$eval('h1', el => el.textContent);

console.log('origin: ', origin);
console.log('heading:', heading);
console.log(origin === FAKE_ORIGIN ? 'PASS' : 'FAIL');

await browser.close();
await stopServer(server);
