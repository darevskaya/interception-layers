/**
 * Framework: Playwright, plus one CDP call
 * Protocol:  CDP, over a session opened on the Playwright page
 * Browser:   Chromium
 *
 * Playwright has no API for CPU throttling, but Chromium exposes it through
 * Emulation.setCPUThrottlingRate. Rather than abandoning the framework, drop to
 * the protocol for the one thing it does not cover and keep using Playwright
 * for everything else. The same loop is timed before and after, so the setting
 * is visibly in effect rather than merely accepted.
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
    // `total` is returned so the loop cannot be optimised away.
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
