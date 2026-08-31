/**
 * Framework: Playwright, plus a CDP session for one missing capability
 * Protocol:  CDP via page.context().newCDPSession()
 *
 * Playwright has no API for CPU throttling, but Chromium exposes it through
 * Emulation.setCPUThrottlingRate. Rather than abandoning the framework, we
 * drop to the protocol for the one thing it does not cover and keep using
 * Playwright for everything else.
 *
 * Run: node examples/playwright-cdp-throttle.js
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN } from '../server/app.js';

const RATE = 6;

/** Time a fixed amount of pointless arithmetic inside the page. */
function measure(page) {
  return page.evaluate(() => {
    const started = performance.now();
    let total = 0;
    for (let i = 0; i < 8_000_000; i++) total += Math.sqrt(i);
    // `total` is returned so the loop cannot be optimised away.
    return { ms: performance.now() - started, total };
  });
}

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(LOCAL_ORIGIN);

const before = await measure(page);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });

const after = await measure(page);

console.log(`unthrottled: ${before.ms.toFixed(0)}ms`);
console.log(`throttled ${RATE}x: ${after.ms.toFixed(0)}ms`);
console.log(`slowdown: ${(after.ms / before.ms).toFixed(1)}x`);
console.log(after.ms > before.ms * 2 ? 'PASS' : 'FAIL');

await cdp.detach();
await browser.close();
await stopServer(server);
