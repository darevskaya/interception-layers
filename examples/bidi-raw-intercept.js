/**
 * Framework: none — raw WebDriver BiDi over a WebSocket
 * Protocol:  WebDriver BiDi
 * Browser:   Firefox (BiDi is available over the remote debugging port directly)
 *
 * The same task as the raw CDP example, over the standardised protocol. The
 * transport is identical in shape — JSON commands with ids, events without —
 * but the command and event names are different, and BiDi requires an
 * explicit session and an event subscription before anything is delivered.
 *
 * Requires a Firefox binary. `npx puppeteer browsers install firefox` is enough —
 * the install is found in puppeteer's browser cache automatically. FIREFOX_PATH
 * overrides that if you want to point at a different binary.
 *
 * Run: node examples/bidi-raw-intercept.js
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { getInstalledBrowsers } from '@puppeteer/browsers';
import WebSocket from 'ws';
import { startServer, stopServer, LOCAL_ORIGIN, FAKE_ORIGIN } from '../server/app.js';
import { step, verdict, wire } from './lib/trace.js';

const BIDI_PORT = 9223;

/** FIREFOX_PATH wins; otherwise take the newest build from puppeteer's cache. */
async function resolveFirefox() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;

  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ?? path.join(homedir(), '.cache', 'puppeteer');

  // An unread cache directory means nothing is installed yet; anything else is
  // a real problem and should not be reported as a missing browser.
  const installed = await getInstalledBrowsers({ cacheDir }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  return installed
    .filter(browser => browser.browser === 'firefox')
    .sort((a, b) => a.buildId.localeCompare(b.buildId, undefined, { numeric: true }))
    .at(-1)?.executablePath;
}

const firefoxPath = await resolveFirefox();

if (!firefoxPath) {
  console.error('No Firefox found. Run: npx puppeteer browsers install firefox');
  console.error('Or set FIREFOX_PATH to an existing binary.');
  process.exit(1);
}

/** Same idea as the CDP helper: match replies to commands by id. */
function createConnection(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());

    if (message.type === 'success' || message.type === 'error') {
      wire('in', `#${message.id}`, message.result ?? message.message);

      const { resolve, reject } = pending.get(message.id) ?? {};
      pending.delete(message.id);

      if (message.type === 'error') reject?.(new Error(message.message));
      else resolve?.(message.result);
      return;
    }

    if (message.type === 'event') {
      wire('event', message.method, message.params);
      for (const listener of listeners) listener(message);
    }
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      wire('out', `#${id} ${method}`, params);
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
    },
  };
}

const server = await startServer();
const profileDir = await mkdtemp(path.join(tmpdir(), 'bidi-profile-'));

const firefox = spawn(firefoxPath, [
  '--headless',
  '--remote-debugging-port', String(BIDI_PORT),
  '--profile', profileDir,
]);

// Firefox exposes the BiDi endpoint at /session once it is ready.
async function connect() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error('could not connect to the BiDi endpoint');
}

step('firefox', firefoxPath);
step('launched firefox', `--remote-debugging-port=${BIDI_PORT}`);

const ws = await connect();
const bidi = createConnection(ws);
step('websocket open', `ws://127.0.0.1:${BIDI_PORT}/session`);

// BiDi needs a session before anything else works. CDP has no equivalent step.
await bidi.send('session.new', { capabilities: {} });
step('session.new', 'no CDP counterpart');

// Events are only delivered after an explicit subscription, and interception
// only blocks requests when the matching event is subscribed to.
await bidi.send('session.subscribe', { events: ['network.beforeRequestSent'] });
step('session.subscribe', 'without it, requests match but are never blocked');

// BiDi matches on the parts of a URL rather than a glob, so the shared
// constant is split rather than interpolated.
const fake = new URL(FAKE_ORIGIN);

await bidi.send('network.addIntercept', {
  phases: ['beforeRequestSent'],
  urlPatterns: [
    { type: 'pattern', protocol: fake.protocol.replace(':', ''), hostname: fake.hostname },
  ],
});
step('intercept armed', `${fake.protocol}//${fake.hostname} at beforeRequestSent`);

bidi.on(async message => {
  if (message.method !== 'network.beforeRequestSent') return;
  if (!message.params.isBlocked) return;

  const { request } = message.params;
  const localUrl = request.url.replace(FAKE_ORIGIN, LOCAL_ORIGIN);

  step('blocked', `${request.method} ${request.url}`);

  const response = await fetch(localUrl, { method: request.method });
  step('fetched', `${response.status} ${response.statusText} <- ${localUrl}`);

  const body = Buffer.from(await response.arrayBuffer());
  step('providing', `${body.length} B, base64 over the wire`);

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

const { contexts } = await bidi.send('browsingContext.getTree', {});
const context = contexts[0].context;

await bidi.send('browsingContext.navigate', {
  context,
  url: `${FAKE_ORIGIN}/`,
  wait: 'complete',
});

const evaluated = await bidi.send('script.evaluate', {
  expression: 'location.origin',
  target: { context },
  awaitPromise: true,
});

const origin = evaluated.result.value;

ws.close();

// Wait for the process to actually exit before removing the profile: on Windows
// the profile files stay locked until it does.
const exited = new Promise(resolve => firefox.once('exit', resolve));
firefox.kill();
await exited;

await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await stopServer(server);

// Reported after teardown, so a late interception cannot print past the verdict.
verdict(origin === FAKE_ORIGIN, `origin   ${origin}`);
