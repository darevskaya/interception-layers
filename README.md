# Browser interception examples

This project shows how to intercept browser requests at different layers: framework APIs, raw CDP (Chrome DevTools Protocol), and raw WebDriver BiDi (a standard protocol for browser automation).

Five examples do the same task. Each example serves a local app at `http://app.invalid`. This is a domain with no DNS record and no hosts entry. Each example intercepts the request before it reaches the network, fetches the response from `http://localhost:3000`, and uses that response to answer the original request. Each example then checks that `location.origin` equals `http://app.invalid`. This check passes only if the browser answered the request at that origin, instead of redirecting it.

Two more examples use protocol access for other purposes.

## Setup

You need Node 22 or newer. The two raw-protocol examples use the global `WebSocket` object, which earlier Node releases do not include.

```sh
npm install
npx playwright install chromium
```

This is the whole setup process. The two raw-protocol examples launch a browser binary (executable file) themselves, instead of using a framework to supply one. The raw CDP example needs Chrome. The raw BiDi example needs Firefox. Each example downloads its own browser binary into a shared cache the first time it runs, and prints a `downloading` line while it does this. Every later run reuses the cache and starts right away. You do not have to install anything by hand. If you already have a Chrome or Firefox binary you want to use instead, set the `CHROME_PATH` or `FIREFOX_PATH` environment variable to skip the download.

Each example starts its own server, runs, stops the server, and prints `PASS` or `FAIL` on the last line.

## Watching it happen

Every example prints a description of what it did. The two raw-protocol examples also print each message sent over the WebSocket connection: `→` marks a command, `←` marks its reply, and `⚡` marks an event.

```
  ▶ websocket open               ws://127.0.0.1:9222/devtools/page/E5E23C6A4389…
  → #1 Fetch.enable              {"patterns":[{"urlPattern":"http://app.invalid/*"…
  ← #1                           {}
  ⚡ Fetch.requestPaused          {"requestId":"interception-job-1.0","request":{…
  ▶ paused                       GET http://app.invalid/
  ▶ fetched                      200 OK <- http://localhost:3000/
  ▶ fulfilling                   249 B, base64 over the wire
  → #4 Fetch.fulfillRequest      {"requestId":"interception-job-1.0","responseCode":200…
```

If you run the raw CDP example and the raw BiDi example one after the other, you see the same pattern in two different protocols. Color output turns off when the output is piped to another program, or when the `NO_COLOR` environment variable is set.

## Interception

| Run | Layer | Key calls |
|-----|-------|-----------|
| `npm run playwright` | Framework API built for this exact case | `page.route(pattern, handler)`, `route.fetch()` → `route.fulfill()` |
| `npm run puppeteer` | Same protocol, differently shaped API | `page.setRequestInterception(true)`, `page.on('request')`, `request.respond()` |
| `npm run raw-cdp` | What the two framework examples do underneath, nothing hidden | `Fetch.enable`, `Fetch.requestPaused`, `Fetch.fulfillRequest` |
| `npm run bidi-raw` | The standardized cross-engine protocol, same detail as the raw CDP example | `network.addIntercept`, `network.beforeRequestSent`, `network.provideResponse` |
| `npm run bidi-puppeteer` | Framework API as a boundary the protocol can change under | the `npm run puppeteer` code + `puppeteer.launch({ protocol: 'webDriverBiDi' })` |

**Playwright to Puppeteer.** Playwright registers a handler for one URL pattern. Puppeteer turns on interception for all requests. Because of this, your code in Puppeteer must match the URL itself, and must call `request.continue()` for every request it does not handle. Puppeteer also has no equivalent to `route.fetch()`, so this example fetches the replacement response and rebuilds it by hand.

**Puppeteer to raw CDP.** Chrome launches with the `--remote-debugging-port` flag. The example finds the page target through `/json/list` and opens its `webSocketDebuggerUrl` directly. After that, everything is JSON. Commands carry an `id` field. Replies echo the same `id`. Any message without an `id` is an event. The `createConnection(ws)` helper is about 35 lines long, and it waits for a reply by matching that `id`. This helper is most of what a protocol client needs to do.

**Raw CDP to raw BiDi.** The transport (the underlying connection) has the same shape in both protocols, but the command and event names are different. BiDi also needs two things that CDP does not: an explicit `session.new` call, and a `session.subscribe` call. Without `session.subscribe`, requests match the pattern, but the browser never blocks them. The raw BiDi example targets **Firefox**, because Firefox exposes BiDi directly on its debugging port. To use BiDi with Chrome, you need chromedriver or the chromium-bidi mapper in between.

**Puppeteer to BiDi Puppeteer.** The interception code is identical, character for character. Only the launch options are different. Puppeteer uses CDP by default for Chrome, so the BiDi Puppeteer example requests BiDi explicitly. For Firefox, BiDi is already the default protocol.

## Other protocol access

| Run | Point | Key calls |
|-----|-------|-----------|
| `npm run cdp-throttle` | Reach one capability the framework lacks without leaving it | `Emulation.setCPUThrottlingRate` via `newCDPSession(page)` |
| `npm run failed-requests` | Filter at the protocol layer so callers get only what they asked | `Network.enable`, `requestWillBeSent`, `responseReceived`, `loadingFailed` |
| `npm run token-cost-comparison` | Measure what that filtering is worth, in tokens | `list_network_requests` via `chrome-devtools-mcp` vs. `Network.enable` filtered locally |

**CPU throttling (`npm run cdp-throttle`).** Chromium can throttle (slow down on purpose) its CPU, but Playwright has no API for this. The example opens one CDP channel for that single call, and uses Playwright for everything else. It times the same loop before and after it applies the throttle, and prints the measured slowdown, so you can see that the setting took effect.

**Filtering failed requests (`npm run failed-requests`).** `getFailedRequests({ urlPattern })` answers one question: did any request matching this pattern fail? It returns only the matching failures, instead of returning the whole network log. This matters most when the caller has a limited context budget. A context budget is a limit on how much data a caller can process at once. In that case, the full log costs resources, not just noise. The example prints a table of every response the page produced next to what the tool actually returns, so you can see which rows the tool discarded.

**Token cost of that filtering (`npm run token-cost-comparison`).** This example measures, in tokens, the saving from the failed-requests example above. It serves a page that makes several requests. Two of the requests fail. The example asks both tools the same question: did `/api/checkout` fail? The baseline drives the real `chrome-devtools-mcp` server over stdio and calls `list_network_requests`. It measures the exact text an agent receives. The narrow tool is the `getFailedRequests` approach from the previous example, filtered before anything is returned. The example tokenizes both results with a GPT tokenizer and prints a table that compares them. This example launches Chrome twice, once for each tool, and downloads `chrome-devtools-mcp` with `npx` the first time it runs.

## Notes

- `.invalid` is a reserved top-level domain. A top-level domain is the last part of a domain name, such as `.com`. `.invalid` never resolves to a real server. Nothing in this project depends on this domain staying unregistered.
- CDP works only with Chromium-based browsers today. Firefox shipped a partial CDP implementation around 2019, mainly so that Puppeteer was able to drive it. Firefox later deprecated and removed this implementation, in favor of BiDi, the standard that Mozilla helped write rather than a copy of another company's protocol. On Firefox 155, the debugging port answers BiDi requests and returns a 404 error for `/json/version`. This removal is the reason the BiDi examples in this project exist.
- BiDi does not yet cover every feature that CDP exposes. This is why the CPU throttling and failed-requests examples use CDP, and why Puppeteer still defaults to CDP for Chrome.
- `server/app.js` is the only file shared by every example. It serves the app page, the `/api/products` endpoint (which succeeds), and the `/api/checkout` endpoint (which always returns a 500 error). Run it by itself with `npm run server`.
- `examples/lib/trace.js` is also shared, but it only formats output: arrows, alignment, and color. It contains no protocol logic, so each example still shows its own mechanism in full.
- The two raw-protocol examples import no framework. They use the global `WebSocket` object and a browser binary, which makes `createConnection()` the whole protocol client. These examples do use the `@puppeteer/browsers` package, but only to download the browser binary. This package is a downloader, not a driver, and no part of it takes part in the protocol.
