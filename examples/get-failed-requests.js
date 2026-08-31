/**
 * Framework: Playwright, plus a CDP session for raw network events
 * Protocol:  CDP (Network domain)
 *
 * A general browser tool would return the whole request list and leave the
 * filtering to whoever called it. This builds the opposite: one narrow
 * function that answers a single question — did anything matching this
 * pattern fail? — and returns nothing else.
 *
 * The filtering happens against the CDP events, so the caller never receives
 * the full network log at all.
 *
 * Run: node examples/get-failed-requests.js
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN } from '../server/app.js';

/**
 * Attach a collector to a page and return a query function.
 * A request counts as failed if it errored outright or came back 4xx/5xx.
 */
async function trackRequests(page) {
  const cdp = await page.context().newCDPSession(page);
  const requests = new Map();
  const failures = [];

  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', event => {
    requests.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
    });
  });

  cdp.on('Network.responseReceived', event => {
    if (event.response.status < 400) return;

    const request = requests.get(event.requestId);
    if (!request) return;

    failures.push({ ...request, status: event.response.status });
  });

  cdp.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId);
    if (!request) return;

    failures.push({ ...request, status: null, error: event.errorText });
  });

  return function getFailedRequests({ urlPattern } = {}) {
    if (!urlPattern) return failures;
    return failures.filter(failure => failure.url.includes(urlPattern));
  };
}

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

const getFailedRequests = await trackRequests(page);

await page.goto(LOCAL_ORIGIN);

// One request that succeeds, one that does not.
await page.evaluate(() => fetch('/api/products'));
await page.click('#checkout');
await page.waitForTimeout(500);

console.log('all failures:');
console.log(JSON.stringify(getFailedRequests(), null, 2));

console.log('\nfiltered to /api/checkout:');
console.log(JSON.stringify(getFailedRequests({ urlPattern: '/api/checkout' }), null, 2));

const matched = getFailedRequests({ urlPattern: '/api/checkout' });
console.log(matched.length === 1 && matched[0].status === 500 ? '\nPASS' : '\nFAIL');

await browser.close();
await stopServer(server);
