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

  trace.step('matched', `${request.method()} ${url}`);

  const localUrl = url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

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

await page.evaluate(url => fetch(url).catch(() => {}), `${LOCAL_ORIGIN}/api/products`);

const origin = await page.evaluate(() => location.origin);
const heading = await page.$eval('h1', el => el.textContent);

await browser.close();
await stopServer(server);

// Reported after teardown, so a late interception cannot print past the verdict.
trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
