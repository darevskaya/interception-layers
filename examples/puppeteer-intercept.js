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

const server = await startServer();
const browser = await puppeteer.launch();
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
