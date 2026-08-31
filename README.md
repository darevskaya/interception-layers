# Browser interception examples

Intercepting browser requests at different layers: framework APIs, raw CDP, raw WebDriver BiDi.

Examples 1–5 do the same thing: serve a local app at `http://app.invalid` — a domain with no DNS record and no hosts entry. The request is intercepted before the network, fetched from `http://localhost:3000`, and used to fulfil the original. Each then asserts `location.origin === 'http://app.invalid'`, which holds only if the request was answered at that origin rather than redirected. Examples 6–7 use protocol access for other things.

## Setup

```sh
npm install
npx playwright install chromium
```

Example 4 also needs Firefox:

```sh
npx puppeteer browsers install firefox
```

It is picked up from puppeteer's browser cache; set `FIREFOX_PATH` only to point at a different binary.

Each example starts and stops its own server and prints `PASS` / `FAIL` on the last line.

## Interception (1–5)

| # | Run | Layer | Key calls |
|---|-----|-------|-----------|
| 1 | `npm run playwright` | Framework API built for this exact case | `page.route(pattern, handler)`, `route.fetch()` → `route.fulfill()` |
| 2 | `npm run puppeteer` | Same protocol, differently shaped API | `page.setRequestInterception(true)`, `page.on('request')`, `request.respond()` |
| 3 | `npm run raw-cdp` | What 1 and 2 do underneath, nothing hidden | `Fetch.enable`, `Fetch.requestPaused`, `Fetch.fulfillRequest` |
| 4 | `npm run bidi-raw` | The standardised cross-engine protocol, same detail as 3 | `network.addIntercept`, `network.beforeRequestSent`, `network.provideResponse` |
| 5 | `npm run bidi-puppeteer` | Framework API as a boundary the protocol can change under | example 2's code + `puppeteer.launch({ protocol: 'webDriverBiDi' })` |

- **1 → 2.** Playwright registers per URL; Puppeteer flips interception on globally, so matching and the explicit `request.continue()` fall-through are yours. No `route.fetch()` equivalent either — the response is rebuilt by hand.
- **2 → 3.** Chromium launches with `--remote-debugging-port`, the page target comes from `/json/list`, and its `webSocketDebuggerUrl` is opened directly. After that it is JSON: commands carry an `id`, replies echo it, anything without one is an event. The ~20-line `createConnection(ws)` helper that awaits on that id-matching is most of what a protocol client is.
- **3 → 4.** Same transport shape, different vocabulary, plus two things CDP needs no equivalent of: an explicit `session.new`, and a `session.subscribe` — without it requests match but are never blocked. Targets **Firefox**, which exposes BiDi on its debugging port; Chrome needs chromedriver or the chromium-bidi mapper in between.
- **2 → 5.** Character-for-character identical interception code; only the launch options differ. Puppeteer defaults to CDP for Chrome, hence the explicit protocol; for Firefox BiDi is already the default.

## Other protocol access (6–7)

| # | Run | Point | Key calls |
|---|-----|-------|-----------|
| 6 | `npm run cdp-throttle` | Reach one capability the framework lacks without leaving it | `Emulation.setCPUThrottlingRate` via `newCDPSession(page)` |
| 7 | `npm run failed-requests` | Filter at the protocol layer so callers get only what they asked | `Network.enable`, `requestWillBeSent`, `responseReceived`, `loadingFailed` |

- **6.** Chromium can throttle CPU; Playwright has no API for it. One CDP channel for that single call, everything else stays Playwright. Times the same loop before and after and prints the measured slowdown, so the setting is visibly in effect.
- **7.** `getFailedRequests({ urlPattern })` answers one question — did anything matching fail? — and returns only matches, instead of handing back the whole network log. Matters most when the caller has a context budget, where the full log is cost, not just noise. The example prints unfiltered and filtered results side by side.

## Notes

- `.invalid` is a reserved TLD guaranteed never to resolve — nothing here depends on a domain staying unregistered.
- CDP is Chromium-only; that is why the BiDi examples exist.
- BiDi does not yet cover everything CDP exposes — hence examples 6 and 7 being CDP-based, and Puppeteer still defaulting to CDP for Chrome.
- `server/app.js` is the only shared file: the app page, `/api/products` (succeeds), `/api/checkout` (always 500). Run alone with `npm run server`.
