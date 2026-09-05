/**
 * Framework: Playwright, plus a CDP session for the network log
 * Protocol:  CDP
 * Browser:   Chromium
 *
 * Filtering at the protocol layer so callers get only what they asked for.
 * getFailedRequests({ urlPattern }) answers one question — did anything
 * matching fail? — and returns only the matches, instead of handing back the
 * whole network log. That matters most when the caller has a context budget,
 * where the full log is cost rather than merely noise.
 *
 * Run: node examples/get-failed-requests.js
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

/**
 * Attach a collector to a page and return a query function, plus a way to wait
 * for a request to settle — the collector already sees every response, so the
 * caller never has to guess at a timeout.
 */
async function trackRequests(page) {
  const cdp = await page.context().newCDPSession(page);
  const requests = new Map();
  const failures = [];
  const waiters = new Set();

  function settle(url) {
    for (const waiter of waiters) {
      if (!url.includes(waiter.urlPattern)) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  }

  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', event => {
    requests.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
    });
  });

  // Consumed once, so the in-flight map stays bounded however long the page runs.
  cdp.on('Network.responseReceived', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    requests.delete(event.requestId);
    settle(request.url);

    if (event.response.status < 400) return;

    failures.push({ ...request, status: event.response.status });
  });

  cdp.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    requests.delete(event.requestId);
    settle(request.url);

    failures.push({ ...request, status: null, error: event.errorText });
  });

  return {
    getFailedRequests({ urlPattern } = {}) {
      if (!urlPattern) return failures;
      return failures.filter(failure => failure.url.includes(urlPattern));
    },
    settled(urlPattern) {
      return new Promise(resolve => waiters.add({ urlPattern, resolve }));
    },
  };
}

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

const { getFailedRequests, settled } = await trackRequests(page);
trace.step('Network.enable', 'collecting, but keeping failures only');

const seen = [];
page.on('response', response => {
  seen.push({
    method: response.request().method(),
    path: new URL(response.url()).pathname,
    status: response.status(),
  });
});

await page.goto(LOCAL_ORIGIN);

// The page-side fetch resolves before the CDP event, so wait on the collector.
const checkoutSettled = settled('/api/checkout');

await page.evaluate(() => fetch('/api/products').catch(() => {}));
await page.evaluate(() => fetch('/api/checkout', { method: 'POST' }).catch(() => {}));
await checkoutSettled;

const failures = getFailedRequests();
const matched = getFailedRequests({ urlPattern: '/api/checkout' });

trace.step('page made', `${seen.length} requests`);
trace.step('tool returns', `${failures.length} failure, ${matched.length} matching /api/checkout`);

console.log('');
trace.table(
  ['method', 'path', 'status', 'returned by the tool'],
  seen.map(request => [
    request.method,
    request.path,
    request.status,
    failures.some(failure => failure.url.endsWith(request.path)) ? 'yes' : '-',
  ]),
);

await browser.close();
await stopServer(server);

trace.verdict(
  matched.length === 1 && matched[0].status === 500,
  `matched  ${matched.map(failure => `${failure.method} ${failure.url} ${failure.status}`).join(', ')}`,
);
