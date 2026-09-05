/**
 * Framework: none. This example uses raw WebDriver BiDi over a WebSocket.
 * Protocol:  WebDriver BiDi
 * Browser:   Firefox. BiDi is available directly over the remote debugging
 *            port.
 *
 * This example does the same task as the raw CDP example, over the
 * standardized WebDriver BiDi protocol. The transport has the same shape in
 * both protocols: JSON commands carry an id, and events do not. The command
 * and event names are different. BiDi also requires an explicit session and
 * an event subscription before it delivers anything.
 *
 * Like the raw CDP example, this file imports no framework. The example
 * downloads Firefox into the shared browser cache the first time it runs, so
 * you do not have to install anything by hand.
 *
 * Run: node examples/bidi-raw-intercept.js
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

const BIDI_PORT = 9223;
const RETRY_LIMIT = 100;
const RETRY_DELAY = 100;

// This function uses the browser cache if Firefox is already there. If the
// cache is empty, it downloads Firefox once. This way, the example runs on a
// machine with no Firefox installed. If you set FIREFOX_PATH, the function
// skips the cache and the download, and uses the binary at that path instead.
async function resolveFirefox() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;

  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ?? path.join(homedir(), '.cache', 'puppeteer');

  const installed = await getInstalledBrowsers({ cacheDir }).catch(() => []);
  const cached = installed.find(entry => entry.browser === Browser.FIREFOX);
  if (cached) return cached.executablePath;

  const buildId = await resolveBuildId(Browser.FIREFOX, detectBrowserPlatform(), 'stable');
  trace.step('downloading', `firefox ${buildId} — first run only`);

  const { executablePath } = await install({ browser: Browser.FIREFOX, buildId, cacheDir });
  return executablePath;
}

function createConnection(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);

    if (message.type === 'success' || message.type === 'error') {
      trace.wire('in', `#${message.id}`, message.result ?? message.message);

      const { resolve, reject } = pending.get(message.id) ?? {};
      pending.delete(message.id);

      if (message.type === 'error') reject?.(new Error(message.message));
      else resolve?.(message.result);
      return;
    }

    if (message.type === 'event') {
      trace.wire('event', message.method, message.params);
      for (const listener of listeners) listener(message);
    }
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

// Firefox exposes the BiDi endpoint at /session once it finishes starting.
async function connect() {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    const socket = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
    try {
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      return socket;
    } catch {
      socket.close();
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  throw new Error('could not connect to the BiDi endpoint');
}

const server = await startServer();
const firefoxPath = await resolveFirefox();
const profileDir = await mkdtemp(path.join(tmpdir(), 'bidi-profile-'));

const firefox = spawn(firefoxPath, [
  '--headless',
  '--remote-debugging-port', String(BIDI_PORT),
  '--profile', profileDir,
]);

trace.step('launched firefox', `--remote-debugging-port ${BIDI_PORT}`);

const ws = await connect();
const bidi = createConnection(ws);
trace.step('websocket open', `ws://127.0.0.1:${BIDI_PORT}/session`);

await bidi.send('session.new', { capabilities: {} });
trace.step('session.new', 'no CDP counterpart');

await bidi.send('session.subscribe', { events: ['network.beforeRequestSent'] });
trace.step('session.subscribe', 'without it, requests match but are never blocked');

// BiDi matches on URL parts (protocol, hostname), not on a glob pattern (a wildcard string). This is why the code splits the FAKE_ORIGIN constant into parts.
const fake = new URL(FAKE_ORIGIN);

await bidi.send('network.addIntercept', {
  phases: ['beforeRequestSent'],
  urlPatterns: [
    { type: 'pattern', protocol: fake.protocol.replace(':', ''), hostname: fake.hostname },
  ],
});

bidi.on(async message => {
  if (message.method !== 'network.beforeRequestSent') return;
  if (!message.params.isBlocked) return;

  const { request } = message.params;
  const localUrl = request.url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  trace.step('blocked', `${request.method} ${request.url}`);

  // The BiDi event carries no request body, unlike CDP's postData field. Because of this, this example only handles GET requests.
  const response = await fetch(localUrl, {
    method: request.method,
    headers: Object.fromEntries(request.headers.map(h => [h.name, h.value.value])),
  });
  trace.step('fetched', `${response.status} ${response.statusText} <- ${localUrl}`);

  const body = Buffer.from(await response.arrayBuffer());
  trace.step('providing', `${body.length} B, base64 over the wire`);

  await bidi.send('network.provideResponse', {
    request: request.request,
    statusCode: response.status,
    reasonPhrase: response.statusText,
    headers: [...response.headers].map(([name, value]) => ({
      name,
      value: { type: 'string', value },
    })),
    body: { type: 'base64', value: body.toString('base64') },
  });
});

const { contexts } = await bidi.send('browsingContext.getTree');
const context = contexts[0].context;

await bidi.send('browsingContext.navigate', {
  context,
  url: `${FAKE_ORIGIN}/`,
  wait: 'complete',
});

const evaluate = async expression => {
  const { result } = await bidi.send('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
  });
  return result.value;
};

const origin = await evaluate('location.origin');
const heading = await evaluate("document.querySelector('h1').textContent");

ws.close();

// On Windows, the profile folder stays locked until the process fully exits.
const exited = new Promise(resolve => firefox.once('exit', resolve));
firefox.kill();
await exited;

await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await stopServer(server);

trace.verdict(origin === FAKE_ORIGIN, `origin   ${origin}`, `heading  ${heading}`);
