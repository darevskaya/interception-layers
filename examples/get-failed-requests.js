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

  // Each request is consumed once, so the in-flight map stays bounded no
  // matter how long the page runs.
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

// One request that succeeds, one that does not. The page-side fetch resolves
// before the CDP event arrives, so wait on the collector rather than on a timer.
const checkoutSettled = settled('/api/checkout');

await page.evaluate(() => fetch('/api/products'));
await page.evaluate(() => fetch('/api/checkout', { method: 'POST' }));
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
