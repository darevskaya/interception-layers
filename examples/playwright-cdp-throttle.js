/**
 * Framework: Playwright, plus one CDP (Chrome DevTools Protocol) call
 * Protocol:  CDP, over a session opened on the Playwright page
 * Browser:   Chromium
 *
 * Playwright has no API for CPU throttling (slowing down the CPU on purpose).
 * Chromium exposes this feature through Emulation.setCPUThrottlingRate. This
 * example does not abandon Playwright. It drops down to the protocol only for
 * this one feature, and uses Playwright for everything else. The example times
 * the same loop before and after it applies the throttle, so you can see that
 * the setting took effect, instead of just trusting that it did.
 *
 * Run: node examples/playwright-cdp-throttle.js
 */
import { chromium } from 'playwright';
import { startServer, stopServer, LOCAL_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const RATE = 6;

function measure(page) {
  return page.evaluate(() => {
    const started = performance.now();
    let total = 0;
    for (let i = 0; i < 8_000_000; i++) total += Math.sqrt(i);
    // The function returns `total` so the JavaScript engine cannot optimize away the loop.
    return { ms: performance.now() - started, total };
  });
}

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(LOCAL_ORIGIN);

const before = await measure(page);
trace.step('measured', `${before.ms.toFixed(0)} ms, unthrottled`);

const cdp = await page.context().newCDPSession(page);
trace.step('cdp session', 'opened on the Playwright page');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
trace.step('setCPUThrottlingRate', `rate ${RATE} — the one call Playwright lacks`);

const after = await measure(page);
trace.step('measured', `${after.ms.toFixed(0)} ms, throttled`);

console.log('');
const slowest = Math.max(before.ms, after.ms);
trace.bar('unthrottled', Math.round(before.ms), slowest);
trace.bar(`throttled ${RATE}x`, Math.round(after.ms), slowest);

await cdp.detach();
await browser.close();
await stopServer(server);

trace.verdict(after.ms > before.ms * 2, `slowdown ${(after.ms / before.ms).toFixed(1)}x`);
