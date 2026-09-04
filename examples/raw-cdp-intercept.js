import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import puppeteer from 'puppeteer';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { trace } from './lib/trace.js';

const DEBUG_PORT = 9222;

// Puppeteer is used only to locate a Chromium binary. Set CHROME_PATH to
// skip it and point at any Chromium install.
const chromePath = process.env.CHROME_PATH ?? (await puppeteer.executablePath());

function createConnection(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());

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
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const target = targets.find(t => t.type === 'page');
      if (target) return target;
    } catch {
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

trace.step('launched chromium', `--remote-debugging-port=${DEBUG_PORT}`);

const target = await findPageTarget();
trace.step('page target', `${target.type} · found through /json/list`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => ws.once('open', resolve));
trace.step('websocket open', target.webSocketDebuggerUrl);

const cdp = createConnection(ws);

// Pause every request aimed at the fake origin, before it hits the network.
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

const { result } = await cdp.send('Runtime.evaluate', {
  expression: 'location.origin',
});

ws.close();

// Wait for the process to actually exit before removing the profile: on Windows
// the profile files stay locked until it does.
const exited = new Promise(resolve => chrome.once('exit', resolve));
chrome.kill();
await exited;

await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await stopServer(server);

// Reported after teardown, so a late interception cannot print past the verdict.
trace.verdict(result.value === FAKE_ORIGIN, `origin   ${result.value}`);
