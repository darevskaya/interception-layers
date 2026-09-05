/**
 * Framework: Playwright (narrow tool) vs. the real chrome-devtools-mcp (baseline)
 * Protocol:  CDP for both. One goes through an MCP server. The other goes directly.
 *
 * Measures how many tokens an agent spends answering one question:
 * "did /api/checkout fail?" Chrome must be installed. chrome-devtools-mcp
 * launches its own instance.
 *
 * Run: node examples/token-cost-comparison.js
 *      node examples/token-cost-comparison.js --quiet   (counts only)
 */
import http from 'node:http';
import { chromium } from 'playwright';
import { countTokens } from 'gpt-tokenizer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;
const TARGET = '/api/checkout';
const SHOW_OUTPUT = !process.argv.includes('--quiet');

// These counts approximate the request count of a modest real page.
const SCRIPTS = 12;
const STYLES = 6;
const IMAGES = 18;

function buildPage() {
  const styles = Array.from({ length: STYLES },
    (_, i) => `<link rel="stylesheet" href="/static/style-${i}.css">`).join('\n');

  const scripts = Array.from({ length: SCRIPTS },
    (_, i) => `<script src="/static/script-${i}.js"></script>`).join('\n');

  const images = Array.from({ length: IMAGES },
    (_, i) => `<img src="/static/img-${i}.png" width="8" height="8">`).join('\n');

  return `<!doctype html>
<html>
  <head><title>Checkout</title>${styles}</head>
  <body>
    ${images}
    ${scripts}
    <script>
      // A handful of XHRs, including the one an agent asks about.
      Promise.allSettled([
        fetch('/api/products'),
        fetch('/api/cart'),
        fetch('/api/user'),
        fetch('/api/recommendations'),
        fetch('/api/inventory'),
        fetch('${TARGET}', { method: 'POST' }),
      ]).then(() => {
        window.__done = true;
      });
    </script>
  </body>
</html>`;
}

function handler(req, res) {
  const { pathname } = new URL(req.url, ORIGIN);

  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildPage());
    return;
  }

  // This is the failure an agent asks about.
  if (pathname === TARGET) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'payment provider unavailable' }));
    return;
  }

  // A second, unrelated failure. It gives the narrow tool something to filter out.
  if (pathname === '/api/inventory') {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'inventory service degraded' }));
    return;
  }

  if (pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: pathname }));
    return;
  }

  if (pathname.endsWith('.css')) {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end(`.c${pathname.length}{color:#333}`);
    return;
  }

  if (pathname.endsWith('.js')) {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`window.__m=(window.__m||0)+1;`);
    return;
  }

  if (pathname.endsWith('.png')) {
    // Smallest valid PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
    return;
  }

  res.writeHead(404);
  res.end();
}

function startServer() {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** Flatten an MCP tool result into the text an agent actually receives. */
function resultText(result) {
  if (result.isError) {
    throw new Error('MCP tool call failed:\n' + (result.content ?? [])
      .map(block => block.text ?? JSON.stringify(block))
      .join('\n'));
  }

  return (result.content ?? [])
    .map(block => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('\n');
}

async function measureMcp() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated'],
  });

  const client = new Client({ name: 'token-cost-comparison', version: '1.0.0' });
  await client.connect(transport);

  // Recent versions default to pageIdRouting, which makes pageId required on
  // page-scoped tools. Read the schemas rather than assuming either way.
  const { tools } = await client.listTools();
  const needsPageId = name => {
    const tool = tools.find(t => t.name === name);
    return Boolean(tool?.inputSchema?.properties?.pageId);
  };

  let pageId;
  if (needsPageId('navigate_page') || needsPageId('list_network_requests') || needsPageId('evaluate_script')) {
    const pages = await client.callTool({ name: 'list_pages', arguments: {} });
    // pageId is reported in the text output. Take the first one it mentions.
    pageId = resultText(pages).match(/\b\d+\b/)?.[0];
  }

  const withPageId = args =>
    pageId !== undefined ? { ...args, pageId: Number(pageId) } : args;

  await client.callTool({
    name: 'navigate_page',
    arguments: withPageId({ url: ORIGIN }),
  });

  // Wait for the page's own XHRs through the server itself, rather than a fixed delay.
  await client.callTool({
    name: 'evaluate_script',
    arguments: withPageId({
      function: 'async () => { while (!window.__done) await new Promise(r => setTimeout(r, 50)); }',
    }),
  });

  const full = await client.callTool({
    name: 'list_network_requests',
    arguments: withPageId({}),
  });

  // The fairest baseline an agent can actually reach: narrow to xhr/fetch.
  // There is still no way to filter by URL or status.
  const narrowed = await client.callTool({
    name: 'list_network_requests',
    arguments: withPageId({ resourceTypes: ['fetch', 'xhr'] }),
  });

  await client.close();

  return { full: resultText(full), narrowed: resultText(narrowed) };
}

async function measureNarrow() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const cdp = await page.context().newCDPSession(page);
  const requests = new Map();
  const failures = [];

  await cdp.send('Network.enable');

  cdp.on('Network.requestWillBeSent', event => {
    requests.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
    });
  });

  cdp.on('Network.responseReceived', event => {
    if (event.response.status < 400) return;
    const request = requests.get(event.requestId);
    if (request) failures.push({ ...request, status: event.response.status });
  });

  cdp.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId);
    if (request) failures.push({ ...request, status: null, error: event.errorText });
  });

  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.__done === true, null, { timeout: 10_000 });

  const matched = failures.filter(failure => failure.url.includes(TARGET));

  await browser.close();

  // Two renderings of the same filtered result: readable JSON, and the same
  // compact one-line-per-request format list_network_requests uses. Measuring
  // both separates the filtering saving from the formatting saving.
  const compact = matched.length === 0
    ? '(no matching failed requests)'
    : matched
        .map(f => `${f.method} ${f.url} [${f.status ?? f.error}]`)
        .join('\n');

  return {
    json: JSON.stringify(matched, null, 2),
    compact,
    totalFailures: failures.length,
  };
}

function row(label, text) {
  return { label, tokens: countTokens(text), chars: text.length };
}

const server = await startServer();

console.log('measuring baseline via chrome-devtools-mcp (this launches Chrome)...');
const mcp = await measureMcp();

console.log('measuring narrow CDP tool...');
const narrow = await measureNarrow();

await new Promise(resolve => server.close(resolve));

const rows = [
  row('list_network_requests (no filter)', mcp.full),
  row('list_network_requests (fetch/xhr only)', mcp.narrowed),
  row(`getFailedRequests (JSON)`, narrow.json),
  row(`getFailedRequests (same format as MCP)`, narrow.compact),
];

if (SHOW_OUTPUT) {
  console.log('\n--- list_network_requests (no filter) ---\n' + mcp.full);
  console.log('\n--- list_network_requests (fetch/xhr only) ---\n' + mcp.narrowed);
  console.log('\n--- getFailedRequests (JSON) ---\n' + narrow.json);
  console.log('\n--- getFailedRequests (same format as MCP) ---\n' + narrow.compact);
}

console.log('\nquestion: did ' + TARGET + ' fail?\n');
console.table(rows);

const unfiltered = rows[0].tokens;
const bestBaseline = rows[1].tokens;
const asJson = rows[2].tokens;
const asCompact = rows[3].tokens;

console.log(`filtering + JSON output:      ${(bestBaseline / asJson).toFixed(1)}x fewer tokens`);
console.log(`filtering, like-for-like:     ${(bestBaseline / asCompact).toFixed(1)}x fewer tokens`);
console.log(`(vs. the unfiltered list:     ${(unfiltered / asCompact).toFixed(1)}x)`);
console.log(`\n(${narrow.totalFailures} requests failed in total; the narrow tool returned only the matching one)`);

console.log(`
Caveats:
- Token counts use a GPT tokenizer; exact numbers differ per model, ratios hold.
- list_network_requests can page and filter by resource type, but not by URL
  or status, so the fetch/xhr row is the best an agent could actually do.
  Compare against that row, not the unfiltered one.
- The last two rows hold the same information and differ only in formatting,
  so the like-for-like ratio is the one attributable to filtering.
- The saving scales with the page. The narrow tool returns one line whether
  the app made six requests or six hundred.
- One page, one question. The ratio is illustrative, not a benchmark.
`);
