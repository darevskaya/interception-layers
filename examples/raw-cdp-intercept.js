/**
 * Framework: none — raw CDP over a WebSocket
 * Protocol:  Chrome DevTools Protocol
 * Browser:   Chromium (launched with --remote-debugging-port)
 *
 * What examples 1 and 2 do underneath, with nothing hidden. The page target
 * comes from /json/list and its webSocketDebuggerUrl is opened directly. After
 * that it is JSON both ways: commands carry an id, replies echo it, and
 * anything without one is an event. The createConnection() helper below, which
 * awaits on that id, is most of what a protocol client is.
 *
 * Nothing here imports a framework: Node builtins, a WebSocket, and a Chrome
 * binary to point them at. The binary is fetched into the shared browser cache
 * on first run, so there is nothing to install by hand.
 *
 * Run: node examples/raw-cdp-intercept.js
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  Browser,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  resolveBuildId,
} from '@puppeteer/browsers';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const DEBUG_PORT = 9222;
const RETRY_LIMIT = 100;
const RETRY_DELAY = 100;

// Uses whatever is already in the browser cache and downloads once if it is
// empty, so the example runs on a machine with no Chrome installed.
// CHROME_PATH skips all of it and points at an existing binary.
async function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ?? path.join(homedir(), '.cache', 'puppeteer');

  const installed = await getInstalledBrowsers({ cacheDir }).catch(() => []);
  const cached = installed.find(entry => entry.browser === Browser.CHROME);
  if (cached) return cached.executablePath;

  const buildId = await resolveBuildId(Browser.CHROME, detectBrowserPlatform(), 'stable');
  trace.step('downloading', `chrome ${buildId} — first run only`);

  const { executablePath } = await install({ browser: Browser.CHROME, buildId, cacheDir });
  return executablePath;
}

const chromePath = await resolveChrome();

function createConnection(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);

    if (message.id !== undefined) {
      trace.wire('in', `#${message.id}`, message.error ?? message.result);

      const { resolve, reject } = pending.get(message.id) ?? {};
      pending.delete(message.id);

      if (message.error) reject?.(new Error(message.error.message));
      else resolve?.(message.result);
      return;
    }

    trace.wire('event', message.method, message.params);
    for (const listener of listeners) listener(message);
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      trace.wire('out', `#${id} ${method}`, params);
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
    },
  };
}

async function findPageTarget() {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const target = targets.find(t => t.type === 'page');
      if (target) return target;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
  }
  throw new Error('no page target found');
}

const server = await startServer();
const profileDir = await mkdtemp(path.join(tmpdir(), 'cdp-profile-'));

const chrome = spawn(chromePath, [
  '--headless',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
]);

trace.step('launched chromium', `--remote-debugging-port=${DEBUG_PORT}`);

const target = await findPageTarget();
trace.step('page target', `${target.type} · found through /json/list`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
trace.step('websocket open', target.webSocketDebuggerUrl);

const cdp = createConnection(ws);

await cdp.send('Fetch.enable', {
  patterns: [{ urlPattern: `${FAKE_ORIGIN}/*`, requestStage: 'Request' }],
});

cdp.on(async message => {
  if (message.method !== 'Fetch.requestPaused') return;

  const { requestId, request } = message.params;
  const localUrl = request.url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  trace.step('paused', `${request.method} ${request.url}`);

  const response = await fetch(localUrl, {
    method: request.method,
    headers: request.headers,
    body: request.postData,
  });
  trace.step('fetched', `${response.status} ${response.statusText} <- ${localUrl}`);

  const body = Buffer.from(await response.arrayBuffer());
  trace.step('fulfilling', `${body.length} B, base64 over the wire`);

  await cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: response.status,
    responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
    body: body.toString('base64'),
  });
});

await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: `${FAKE_ORIGIN}/` });

await new Promise(resolve => {
  cdp.on(message => {
    if (message.method === 'Page.loadEventFired') resolve();
  });
});

trace.step('loaded', 'Page.loadEventFired');

const evaluate = async expression => {
  const { result } = await cdp.send('Runtime.evaluate', { expression });
  return result.value;
};

const origin = await evaluate('location.origin');
const heading = await evaluate("document.querySelector('h1').textContent");

ws.close();

// On Windows the profile stays locked until the process is really gone.
const exited = new Promise(resolve => chrome.once('exit', resolve));
chrome.kill();
await exited;

await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await stopServer(server);

trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
