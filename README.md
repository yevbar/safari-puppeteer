<p align="center">
  <img src="https://raw.githubusercontent.com/yevbar/safari-puppeteer/master/logo.png"
       alt="Safari combined with Puppeteer" width="560">
</p>

# safari-puppeteer

Control a **local, real Safari** with the Puppeteer API, backed by
`safaridriver` (W3C WebDriver) and AppleScript.

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
| `src/mcp/` | Optional `safaridriver --mcp` client |
| `src/backend/` | `PageBackend` interface, and the WebDriver and MCP implementations |
| `src/api/` | `Browser` / `Page` / `ElementHandle` / `Keyboard` / `Mouse` |

Why AppleScript as well? A WebDriver session is sandboxed to the window it
created. AppleScript sees the whole Safari application — the user's own windows
and tabs, app activation, window geometry, native menus. The two together cover
considerably more than either alone.

**This is not a Playwright-style WebKit build.** It drives the actual Safari on
your Mac, with its real engine, codecs, and quirks. That is the point — and it
is also why some Puppeteer APIs cannot exist here (see
[Unsupported](#unsupported-apis)).

Everything above works on stable Safari. **Network inspection is the one
exception: it requires Safari Technology Preview 247+**, because it depends on
`safaridriver --mcp`, which stable Safari does not ship. See
[Backends](#backends).

## Setup

Run the doctor first. It ships with the package, checks every prerequisite, and
prints the exact fix for anything missing:

```bash
npm install safari-puppeteer
npx safari-puppeteer doctor
```

It reports macOS and Safari versions, whether the driver is enabled, whether
Remote Automation works (by creating a real session), whether the screen is
locked, whether AppleScript is permitted, and whether any driver supports
`--mcp`. Exit code 0 means Safari can be driven.

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

### Driving your real Safari

A WebDriver session is sandboxed to the window it created, so it cannot see the
browser you actually use. The AppleScript bridge can — including tabs you are
already logged into:

```ts
import { SafariApp } from 'safari-puppeteer';
const safari = new SafariApp();          // or 'Safari Technology Preview'

await safari.listTabs();                 // every window and tab
await safari.tabSource(3);               // that tab's HTML, without running any script
await safari.tabText(3);                 // its rendered text
await safari.navigateTab(url, 3);        // point an existing tab somewhere
await safari.activateTab(3);
await safari.reloadTab(3);
await safari.closeTab(3);
await safari.newWindow(url);
```

Tab and window indices are 1-based, as in AppleScript; `tabSource` is the useful
one, since it returns markup without executing anything in the page.

This needs Automation permission (macOS prompts once).
`doJavaScript()` additionally needs Develop → *Allow JavaScript from Apple
Events*, and is lossy: numbers come back as reals (`1 + 1` → `"2.0"`), `null`,
`undefined` and thrown errors all come back as `""`, and **page-side exceptions
are not surfaced** — a throw is indistinguishable from null. Prefer
`page.evaluate()` whenever a WebDriver session will do.

`clearHistory()` is not available: Safari's dictionary has no history command,
and it throws rather than pretending.

## Unsupported APIs

These throw `UnsupportedOperationError` with the reason and the closest
alternative, rather than failing silently or pretending to work:

| API | Why | Instead |
|---|---|---|
| `launch({ headless: true })` | Safari has no headless mode | Move the window off-screen |
| `page.pdf()` | safaridriver does not implement WebDriver `print` | AppleScript print flow, or render server-side |
| `page.setRequestInterception()` | No channel can modify traffic: WebDriver has no network layer, MCP only observes, BiDi's `network` module is missing | Local proxy |
| `page.networkRequests()` | The WebDriver backend has no network layer | `launch({ backend: 'mcp' })` — **needs Safari Technology Preview 247+** |
| `page.setUserAgent()` | No capability or endpoint exists | Develop → User Agent menu |
| `page.emulate()` | No CDP Emulation domain | `setViewport`, or a real device/simulator |
| `page.emulateMediaFeatures()` | No CDP Emulation domain; MCP offers media *type* only | Inject CSS with `page.evaluate()` |
| `page.setOfflineMode()` | No network control | Network Link Conditioner |
| `page.screenshot({ clip })` | No region-capture command | `elementHandle.screenshot()`, or crop yourself |
| `page.cookies(...urls)` | Driver only sees the active document | Navigate per origin |
| `elementHandle.contentFrame()` | No element→frame mapping | `page.enterFrame()` |

## Behavioural differences from Puppeteer

Worth reading before you debug something surprising:

- **`goto` returns `null`, not an `HTTPResponse`.** Neither backend exposes
  response metadata — no status, no headers. Returning a fake object would be
  worse than returning nothing. It does **throw** when the navigation failed
  outright (refused connection, unresolvable host), since both backends
  otherwise report that as success and leave you on Safari's error page. An
  HTTP error status is not a failure: a 404 resolves, as it does in Puppeteer.
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
- **`uploadFile` goes through "send keys to a file input"**, since WebDriver has
  no upload command. Verified working on Safari 26.6 for single and multiple
  files, including the `change` event and the file's contents being readable
  in-page. Safari's support here has been inconsistent historically, so the
  integration suite asserts it rather than assuming it.
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

## Backends

> ### ⚠️ Network inspection requires Safari Technology Preview
>
> `page.networkRequests()` and everything else in this section depend on
> `safaridriver --mcp`, which ships **only in Safari Technology Preview 247+ /
> Safari 27 beta**. It does not exist in stable Safari (26.6 included) — its
> `safaridriver` has no `--mcp` flag at all.
>
> On a stable Safari the default backend is your only option, and network
> traffic is not observable through any Safari automation channel. If you cannot
> install a preview build, use a local proxy instead.
>
> Install: `brew install --cask safari-technology-preview` — then see
> [Setup for the MCP backend](#setup-for-the-mcp-backend). Run `npm run doctor`
> to check.

Pages are driven by a **backend**. There are two, and they are not equally
capable — which is why the choice is explicit and the default is conservative.

```ts
launch({ backend: 'webdriver' })   // default: stable Safari, full API
launch({ backend: 'mcp', safaridriverPath: TECH_PREVIEW_SAFARIDRIVER })
```

The MCP backend exists for one reason: **network inspection that applies to the
page you are actually driving**. The `safaridriver --mcp` server can only
observe tabs it created itself, so while a WebDriver session owns the page there
is no way to see its traffic. Making MCP the only channel is what puts
`page.networkRequests()` within reach.

```ts
import { launch, TECH_PREVIEW_SAFARIDRIVER } from 'safari-puppeteer';

const browser = await launch({ backend: 'mcp', safaridriverPath: TECH_PREVIEW_SAFARIDRIVER });
const [page] = await browser.pages();

await page.goto('https://example.com');
const { count, requests } = await page.networkRequests();
// [{ url, method, status, mime_type, response_size_bytes, duration_ms, initiator }]

await page.emulateMediaType('print');
```

### What each backend can do

| | `webdriver` | `mcp` |
|---|---|---|
| Stable Safari | ✅ | ❌ Technology Preview 247+ only |
| `goto`, `evaluate`, `$eval`, `$$eval`, `waitFor*` | ✅ | ✅ |
| `screenshot({ fullPage })` | emulated by resizing | ✅ native |
| `page.networkRequests()` | ❌ no network layer | ✅ **the reason to use it** |
| `page.emulateMediaType()` | ❌ | ✅ (type only, not features) |
| Console and dialog events | ✅ | ✅ (server-side buffer, so nothing is missed) |
| `page.$`, `$$`, `evaluateHandle` | ✅ | ❌ no element references |
| `page.cookies()` and friends | ✅ | ❌ no cookie tool |
| `enterFrame`, `$x`, `windowRect` | ✅ | ❌ |
| `page.keyboard` / `page.mouse` | ✅ W3C Actions | ❌ selector-level input only |
| `page.click`, `hover`, `select` | ✅ | ✅ |
| `page.type` | ✅ fast | ✅ real key events, but **~0.4 s per character** |

Anything a backend cannot do throws `UnsupportedOperationError` naming the
backend and the alternative, so a script that outgrows the MCP backend says so
rather than misbehaving.

Three behaviours of the MCP backend are worth knowing:

- **`page.type()` costs about 0.4 s per character.** The server's own `type`
  interaction needs a node identifier from `get_page_content`, and the
  `$uid(N)` macro that would map a selector onto one is not implemented in
  Technology Preview 249, so typing goes key by key. That is slower but real:
  the page sees genuine `keydown`/`keypress`, which assigning `value` in-page
  would not produce. For long strings where you do not need the events,
  `page.evaluate()` is far faster.

- **Recording must start before the traffic.** The first `list_network_requests`
  call arms capture and returns nothing. The backend arms it before your first
  navigation so `page.networkRequests()` just works, but the same rule applies
  if you drive a standalone `SafariMcp` yourself — call `startNetworkCapture()`
  first.
- **Loopback traffic is never recorded.** Navigating to `127.0.0.1` produces a
  working page and an empty request log, while the next navigation to a public
  origin in the same tab is captured normally. Local fixture servers are
  invisible to it.

### Using the MCP client directly

There is deliberately no way to attach an MCP server to a WebDriver-backed
`Browser`. It would imply a relationship that does not exist: the server cannot
see pages a WebDriver session owns, so anything it reported would describe a
different browsing context. `backend: 'mcp'` is how you get inspection of your
own pages.

If you want the raw 17-tool client for its own sake, it is exported and says
what it is:

```ts
import { SafariMcp, TECH_PREVIEW_SAFARIDRIVER } from 'safari-puppeteer';

const mcp = await SafariMcp.start({ binary: TECH_PREVIEW_SAFARIDRIVER });
const tab = await mcp.createTab();      // its own tab, not one of yours
await mcp.switchTab(tab.handle);
await mcp.startNetworkCapture(tab.handle);
await mcp.navigate('https://example.com/', tab.handle);
await mcp.listNetworkRequests({ tabHandle: tab.handle });
await mcp.close();
```

### Setup for the MCP backend

```bash
brew install --cask safari-technology-preview
"/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" --enable
```

Then in **Safari Technology Preview** — its settings are separate from Safari's,
and enabling the toggle in one does nothing for the other:

1. Settings → Advanced → *Show features for web developers*
2. Settings → Developer → *Allow remote automation and external agents*

`npm run doctor` reports whether any driver on the machine supports `--mcp`.

The server is itself backed by WebDriver internally, so it needs that same
permission — but only discovers it on the first tool call that touches the
browser. `initialize` and `tools/list` succeed regardless, which makes a missing
toggle look like a tool bug rather than a setup step. We translate that error
into the fix.

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
npm run doctor            # check the environment (same as npx safari-puppeteer doctor)
npm test                  # unit + MCP tests, no Safari needed
npm run test:mcp          # MCP protocol tests against a fake stdio server
npm run test:applescript  # AppleScript bridge against your real Safari
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
Safari 26.6 on macOS 26.6.

**The MCP backend and all network inspection additionally require Safari
Technology Preview 247+** (verified against Release 249). `safaridriver --mcp`
does not exist in stable Safari, so on a stable-only machine
`launch({ backend: 'mcp' })` throws at startup with install instructions, and
`page.networkRequests()` is unavailable. Everything else in this README works on
stable Safari.

## License

MIT
