# safari-puppeteer

Control a **local, real Safari** with the Puppeteer API, backed by
`safaridriver` (W3C WebDriver) and AppleScript.

> The npm package is **`safari-puppeteer`**; the repository is
> `yevbar/puppeteer-safari`. The `puppeteer-safari` name on npm is taken by an
> unrelated placeholder package.

```bash
npm install safari-puppeteer
```

ESM-only, macOS-only, Node 18+. The public types expose `Buffer` and extend
`EventEmitter`, so `@types/node` is a real dependency and is installed for you.

```ts
import { launch } from 'safari-puppeteer';

const browser = await launch({ defaultViewport: { width: 1280, height: 800 } });
const [page] = await browser.pages();

await page.goto('https://example.com');
console.log(await page.title());
await page.screenshot({ path: 'example.png' });

await browser.close();
```

## What this does

Puppeteer speaks the **Chrome DevTools Protocol**. Safari does not implement CDP
and never will. Safari's only automation surface is `safaridriver`, which speaks
**classic W3C WebDriver** — a request/response protocol with no event stream and
no network layer.

This library is a Puppeteer-API-compatible facade over that protocol:

| Layer | Role |
|---|---|
| `src/webdriver/client.ts` | Typed W3C WebDriver client over `fetch` |
| `src/webdriver/safaridriver.ts` | Spawns and health-checks the `safaridriver` process |
| `src/applescript/` | `osascript` bridge for what WebDriver cannot reach |
| `src/mcp/` | Optional `safaridriver --mcp` channel for network/console inspection |
| `src/api/` | `Browser` / `Page` / `ElementHandle` / `Keyboard` / `Mouse` |

Why AppleScript as well? A WebDriver session is sandboxed to the window it
created. AppleScript sees the whole Safari application — the user's own windows
and tabs, app activation, window geometry, native menus. The two together cover
considerably more than either alone.

**This is not a Playwright-style WebKit build.** It drives the actual Safari on
your Mac, with its real engine, codecs, and quirks. That is the point — and it
is also why some Puppeteer APIs cannot exist here (see
[Unsupported](#unsupported-apis)).

## Setup

Run the doctor first. It checks every prerequisite and prints the exact fix for
anything missing:

```bash
npm install
npm run doctor
```

Two one-time settings are required, and neither can be scripted (both are
OS-level trust decisions):

1. **Enable the driver** — prompts for your password:
   ```bash
   safaridriver --enable
   ```
2. **Allow Remote Automation** in Safari:
   - Settings → Advanced → check *Show features for web developers*
   - **Develop** menu → check *Allow Remote Automation*

Optional, only for the AppleScript features:

- Develop → *Allow JavaScript from Apple Events* (for `SafariApp.doJavaScript`)
- System Settings → Privacy & Security → Automation → enable Safari for your
  terminal (macOS prompts the first time)

## Supported API

Navigation, evaluation, selectors, waiting, input, cookies, screenshots, tabs:

```ts
await page.goto(url, { waitUntil: 'load' });
await page.reload(); await page.goBack(); await page.goForward();
await page.setContent(html);
await page.content(); await page.title(); await page.url();

await page.evaluate(fn, ...args);
await page.evaluateHandle(fn);          // real handles, see below
await page.$(sel); await page.$$(sel); await page.$x(xpath);
await page.$eval(sel, fn); await page.$$eval(sel, fn);

await page.waitForSelector(sel, { visible, hidden, timeout });
await page.waitForFunction(fn, { timeout, polling });
await page.waitForNavigation();

await page.click(sel); await page.type(sel, text);
await page.hover(sel); await page.focus(sel); await page.select(sel, value);
await page.keyboard.press('ArrowLeft'); await page.keyboard.type('hi');
await page.mouse.click(x, y); await page.mouse.wheel({ deltaY: 200 });

await page.cookies(); await page.setCookie(c); await page.deleteAllCookies();
await page.screenshot({ path, fullPage });
await elementHandle.screenshot();
await page.setViewport({ width, height });

await browser.newPage(); await browser.pages(); await browser.close();
```

Events (`page.on('console')`, `page.on('dialog')`, `page.on('pageerror')`) work,
but are **polled** — see below.

### Handles

`evaluateHandle` returns a real handle to a non-serializable in-page value. Since
WebDriver can only return JSON plus element references, handles are backed by a
registry inside the page (`ExecutionContext`):

```ts
const handle = await page.evaluateHandle(() => window);
await handle.evaluate((win: Window) => win.location.href);
await handle.dispose();
```

Handles live on `window`, so **navigation invalidates them**. Using a stale
handle throws a message that says exactly that.

### Frames

WebDriver models frames as driver *state*, not as objects, so frame access is a
mode switch rather than Puppeteer's `frame.$()`:

```ts
const iframe = await page.$('iframe');
await page.enterFrame(iframe);   // queries now target the iframe
await page.$('#inside-frame');
await page.exitFrame();
```

### Escape hatches

Nothing is sealed off. `page.client` is the raw WebDriver client and
`page.safari` is the AppleScript bridge:

```ts
await page.client.send('POST', `/session/${id}/custom`, body);
await page.safari.listTabs();      // every Safari tab, not just this session
await page.safari.activate();
```

## Unsupported APIs

These throw `UnsupportedOperationError` with the reason and the closest
alternative, rather than failing silently or pretending to work:

| API | Why | Instead |
|---|---|---|
| `launch({ headless: true })` | Safari has no headless mode | Move the window off-screen |
| `page.pdf()` | safaridriver does not implement WebDriver `print` | AppleScript print flow, or render server-side |
| `page.setRequestInterception()` | No channel can modify traffic: WebDriver has no network layer, MCP only observes, BiDi's `network` module is missing | Local proxy |
| `page.networkRequests()` | MCP cannot see WebDriver-owned tabs | `browser.mcp()` on a tab MCP created |
| `page.setUserAgent()` | No capability or endpoint exists | Develop → User Agent menu |
| `page.emulate()` | No CDP Emulation domain | `setViewport`, or a real device/simulator |
| `page.emulateMediaFeatures()` | No CDP Emulation domain; MCP offers media *type* only | Inject CSS with `page.evaluate()` |
| `page.setOfflineMode()` | No network control | Network Link Conditioner |
| `page.screenshot({ clip })` | No region-capture command | `elementHandle.screenshot()`, or crop yourself |
| `page.cookies(...urls)` | Driver only sees the active document | Navigate per origin |
| `elementHandle.contentFrame()` | No element→frame mapping | `page.enterFrame()` |

## Behavioural differences from Puppeteer

Worth reading before you debug something surprising:

- **`goto` returns `null`, not an `HTTPResponse`.** WebDriver exposes no
  response metadata — no status, no headers. Returning a fake object would be
  worse than returning nothing.
- **`waitUntil: 'networkidle0' | 'networkidle2'`** have no request-count signal
  behind them. They fall back to a quiet-period heuristic.
- **Console and dialog events are polled** (250ms / 200ms). Messages logged
  before a listener is attached are lost, and arguments are stringified in-page
  rather than passed as handles.
- **A JS dialog blocks everything.** While an `alert()`/`confirm()` is open,
  every WebDriver command fails with `unexpected alert open`. Attach a `dialog`
  listener if your page uses them.
- **`evaluateOnNewDocument` runs *after* navigation completes**, not before page
  scripts. WebDriver cannot inject at document start.
- **`fullPage` screenshots are emulated** by temporarily growing the window,
  because safaridriver clipped `/screenshot` to the viewport before Safari 27 /
  STP 247. Very tall pages can still be truncated at the screen limit.
- **`setViewport` resizes the window** and compensates for Safari's chrome by
  measuring. `deviceScaleFactor`, `isMobile`, `hasTouch` and `isLandscape` are
  ignored — real Safari cannot emulate them.
- **Screenshots come back at the display's pixel ratio.** On a Retina Mac a
  1024×768 viewport produces a 2048×1536 PNG, whereas Puppeteer defaults to 1×.
  There is no way to override this: the capture happens in the real display
  pipeline. Downscale afterwards if you need CSS-pixel dimensions.
- **One session at a time.** safaridriver serves a single session per instance;
  `browser.newPage()` opens tabs multiplexed over that one session by switching
  window handles.
- **`uploadFile` is best-effort.** Safari's support for the spec's file-input
  behaviour is historically inconsistent — verify on your version.
- **`isVisible()` is computed in-page.** safaridriver does not implement
  WebDriver's `/element/{id}/displayed` endpoint — it answers `unknown
  command` — so visibility is evaluated with `checkVisibility()` plus a
  zero-area check instead.

## The screen must be unlocked

This one costs people an afternoon, so it is worth stating plainly.

**While the macOS screen is locked, pointer events do nothing.** No window can
become the key window, so the OS never delivers synthesized clicks to Safari.
`page.click()`, `mouse.click()`, `hover()` and `tap()` all return successfully
and have no effect — no error is raised. Whatever you were waiting on then times
out with a message about the wait, not about the cause.

Measured on Safari 18.6, while locked:

| Still works | Silently does nothing |
|---|---|
| navigation, `evaluate`, screenshots, cookies | `page.click()`, `mouse.click()` |
| `page.type()`, `keyboard.press()` | `hover()`, `tap()` |
| `element.click()` dispatched inside `evaluate` | any pointer Actions sequence |

`npm run doctor` reports the lock state, and the integration suite skips its
pointer tests with an explanation rather than timing out. A remote or headless
CI runner has the same problem for the same reason — that is one of several
reasons Safari automation needs a real, unlocked GUI session.

## The MCP channel (optional)

Safari Technology Preview 247+ / Safari 27 beta ship `safaridriver --mcp`, an
official Model Context Protocol server. It adds the one thing WebDriver has no
answer for: read-only visibility into network traffic.

**Read this part before building on it.** The MCP server is not a view onto the
pages you are driving. It is a *separate browsing context* that sees only tabs
it created itself. Measured on Technology Preview 249, while a WebDriver session
holds a tab, `list_tabs` returns `[]` and `page_info` answers `No active tab`.

That is why there is no `page.networkRequests()`: routing it through MCP would
have reported on a different page than the one you navigated, silently. It
throws with an explanation instead.

So the working shape is an independent session that you drive with MCP's own
tab tools:

```ts
import { launch, TECH_PREVIEW_SAFARIDRIVER } from 'safari-puppeteer';

const browser = await launch({
  mcp: true,
  safaridriverPath: TECH_PREVIEW_SAFARIDRIVER,
});

const mcp = await browser.mcp();
const tab = await mcp.createTab();                  // MCP must own the tab
await mcp.switchTab(tab.handle);
await mcp.navigate('https://example.com/', tab.handle);

const { count, requests } = await mcp.listNetworkRequests({ tabHandle: tab.handle });
// [{ url, method, status, mime_type, response_size_bytes, duration_ms, initiator }]
```

Capture only covers navigations made *after* the tab exists, so that ordering
is load-bearing — navigate first and the list comes back empty.

`mcp: true` reuses whichever `safaridriverPath` you are already driving Safari
with, because pointing a stable-Safari WebDriver session at a Technology Preview
MCP server would observe a different browser entirely. It throws at launch, with
install instructions, if that driver has no `--mcp`.

Install and enable:

```bash
brew install --cask safari-technology-preview
"/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" --enable
```

Then in **Safari Technology Preview** — its settings are separate from Safari's,
and enabling the toggle in one does nothing for the other:

1. Settings → Advanced → *Show features for web developers*
2. Settings → Developer → *Allow remote automation and external agents*

`npm run doctor` reports whether any driver on the machine supports `--mcp`.

### What it does and does not add

Measured against Technology Preview 249, not taken from the docs:

| | |
|---|---|
| ✅ `mcp.listNetworkRequests()` | Real detail: method, status, MIME type, size, timing, initiator |
| ✅ `mcp.getNetworkRequest(id)` | Headers and body for one request |
| ✅ `mcp.screenshot({ fullPage })` | Native, not emulated by resizing the window |
| ✅ `mcp.pageContent()` | Accessibility tree, event listeners, rects, subframes |
| ⚠️ `mcp.setEmulatedMediaType()` | Media **type** (`screen`/`print`) only — *not* `prefers-color-scheme` |
| ✅ `mcp.evaluate()` | Works — but the tool's input is a *function body*, not an expression |
| ❌ Loopback traffic | Requests to `127.0.0.1` are never recorded |
| ❌ Observing your Puppeteer page | Separate browsing context, see above |
| ❌ Request interception | Observation only — no blocking or modification |

Three of these are worth dwelling on, because the docs imply otherwise:

- **`set_emulated_media` is not `emulateMediaFeatures`.** Its schema takes a
  string — a CSS media *type*. There is no way to set `prefers-color-scheme`,
  and passing an object fails with `Invalid arguments: Missing required 'media'`.
- **`evaluate_javascript` takes a function body, not an expression.** Sending
  `1+1` evaluates and discards, answering `null`; `return 1+1` gives `2`. Our
  `mcp.evaluate()` adds the `return` for you, and `mcp.evaluateBody()` passes
  statements through untouched.
- **Local fixture servers are invisible.** Navigating a single tab to
  `127.0.0.1` records nothing, while the very next navigation to a public
  origin in that same tab is captured normally. That rules out the usual
  hermetic-test pattern of serving fixtures locally.

The MCP server is itself backed by WebDriver internally, so it needs the same
Safari permission — but it only discovers that on the first tool call that
touches the browser. `initialize` and `tools/list` succeed regardless, which
makes a missing toggle look like a tool bug rather than a setup step. We
translate that error into the fix.

## Why not WebDriver BiDi?

BiDi is the protocol that would let Puppeteer drive Safari properly, and
Puppeteer already supports a BiDi transport. Apple has now started shipping it:
`safaridriver` in **Safari 26.6** has a `-b, --bidi` flag.

It is not usable as a backend yet. Measured against Safari 26.6:

| Module | State |
|---|---|
| `session`, `browsingContext` | Working — `getTree`, `navigate`, and real `load`/`domContentLoaded` events |
| `log` | Working — `log.entryAdded` fires |
| `script` | Present, but values come back as `{type:"object", value:"<JSON string>"}` rather than proper RemoteValues |
| `network` | **Missing** — `unknown command: 'network' domain was not found` |
| `input` | **Missing** — `unknown command: 'input' domain was not found` |
| `storage` | Errors with `InternalError` |

Two traps worth knowing. The spec-standard `webSocketUrl: true` capability
returns the boolean `true` and opens no socket; you must pass Apple's
`safari:experimentalWebSocketUrl: true` to get a real URL. And the port given to
`--bidi` is ignored — the server picks its own.

Most importantly, subscribing to `network.beforeRequestSent` **succeeds and then
never fires an event**, which is a worse failure mode than the honest
`unknown command` you get from `network.addIntercept`. So BiDi does not yet
close the request-interception gap either.

Classic WebDriver therefore remains the only viable backend. When the `network`,
`input`, and `script` modules land, the `src/api/` layer can be repointed at
BiDi without changing the public API.

## Development

```bash
npm run doctor            # check the environment
npm test                  # unit + MCP tests, no Safari needed
npm run test:mcp          # MCP protocol tests against a fake stdio server
npm run test:integration  # drives a real Safari window; skips if unavailable
npm run test:package      # pack, install, and import the built tarball
npm run build             # emit dist/
npm run example           # examples/screenshot.ts
```

Source uses `.ts` import specifiers so it runs directly under
`node --experimental-strip-types` (Node 22.6+) with no build step. `tsc`
rewrites them to `.js` on emit; `scripts/fix-dts-extensions.mjs` does the same
for declaration files, which `rewriteRelativeImportExtensions` does not cover as
of TypeScript 5.9. `npm run test:package` asserts none leak through.

### Publishing

`prepublishOnly` runs the build, the unit tests, and the package verification.

```bash
npm login
npm publish     # publishConfig.access is already set to public
```

## Requirements

macOS with Safari. Node 18+. Tested against Safari 18.6 on macOS 15.6 and
Safari 26.6 on macOS 26.6. The optional MCP channel additionally needs Safari
Technology Preview 247+ (verified against Release 249).

## License

MIT
