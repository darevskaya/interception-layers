/**
 * Serves the local app at http://app.invalid using page.route(), without
 * any DNS or hosts file entry for that domain.
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

// Trace only: the handler below is called for matching requests and nothing
// else, so counting every request the page makes is the only way to see how
// many Playwright filtered out on its own.
let seen = 0;
let handled = 0;
page.on('request', () => (seen += 1));

trace.step('page.route()', `${FAKE_ORIGIN}/** — matching requests only`);

await page.route(`${FAKE_ORIGIN}/**`, async route => {
  const request = route.request();
  const localUrl = request.url().replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  handled += 1;
  trace.step('matched', `${request.method()} ${request.url()}`);

  const response = await route.fetch({ url: localUrl });
  trace.step('fetched', `${response.status()} ${response.statusText()} <- ${localUrl}`);

  await route.fulfill({ response });
  trace.step('fulfilled', 'the response object, passed straight through');
});

await page.goto(`${FAKE_ORIGIN}/`);

// One request that is not aimed at the fake origin. Playwright never calls the
// handler for it — compare the two counts below with the puppeteer example,
// where every request arrives and the fall-through is written out by hand.
await page.evaluate(url => fetch(url).catch(() => {}), `${LOCAL_ORIGIN}/api/products`);

// The page really believes it was served from app.invalid.
const origin = await page.evaluate(() => location.origin);
const heading = await page.textContent('h1');

trace.step('requests', `${seen} made by the page, ${handled} reached the handler`);

await browser.close();
await stopServer(server);

// Reported after teardown, so a late interception cannot print past the verdict.
trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
