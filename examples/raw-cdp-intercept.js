/**
 * Framework: none — raw Chrome DevTools Protocol over a WebSocket
 * Protocol:  CDP
 *
 * The same task as the Playwright and Puppeteer examples, written directly
 * against the protocol: launch Chromium with remote debugging, find the page
 * target, open its WebSocket, enable Fetch interception, and answer paused
 * requests ourselves.
 *
 * Run: node examples/raw-cdp-intercept.js
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';

const DEBUG_PORT = 9222;

// Puppeteer is used only to locate a Chromium binary. Set CHROME_PATH to
// skip it and point at any Chromium install.
const chromePath = process.env.CHROME_PATH ?? puppeteer.executablePath();

/**
 * A CDP connection is JSON messages over a WebSocket. Commands carry an id;
 * the browser replies with a message carrying the same id. This helper tracks
 * pending ids so each command can be awaited like a normal function call.
 */
function createConnection(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());

    if (message.id !== undefined) {
      const { resolve, reject } = pending.get(message.id) ?? {};
      pending.delete(message.id);

      if (message.error) reject?.(new Error(message.error.message));
      else resolve?.(message.result);
      return;
    }

    // No id means it is an event, not a command response.
    for (const listener of listeners) listener(message);
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
    },
  };
}

/** Poll /json/list until Chromium is up, then return the page target. */
async function findPageTarget() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const target = targets.find(t => t.type === 'page');
      if (target) return target;
    } catch {
      // Chromium has not opened the port yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('no page target found');
}

const server = await startServer();
const profileDir = await mkdtemp(path.join(tmpdir(), 'cdp-profile-'));

const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
]);

const target = await findPageTarget();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.once('open', resolve));

const cdp = createConnection(ws);

// Pause every request aimed at the fake origin, before it hits the network.
await cdp.send('Fetch.enable', {
  patterns: [{ urlPattern: `${FAKE_ORIGIN}/*`, requestStage: 'Request' }],
});

cdp.on(async message => {
  if (message.method !== 'Fetch.requestPaused') return;

  const { requestId, request } = message.params;
  const localUrl = request.url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  const response = await fetch(localUrl, {
    method: request.method,
    headers: request.headers,
    body: request.postData,
  });

  const body = Buffer.from(await response.arrayBuffer());

  await cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: response.status,
    responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
    body: body.toString('base64'),
  });
});

await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: `${FAKE_ORIGIN}/` });

// Wait for the load event before reading anything back out of the page.
await new Promise(resolve => {
  cdp.on(message => {
    if (message.method === 'Page.loadEventFired') resolve();
  });
});

const { result } = await cdp.send('Runtime.evaluate', {
  expression: 'location.origin',
});

console.log('origin: ', result.value);
console.log(result.value === FAKE_ORIGIN ? 'PASS' : 'FAIL');

ws.close();
chrome.kill();
await rm(profileDir, { recursive: true, force: true });
await stopServer(server);
