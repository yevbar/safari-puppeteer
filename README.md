# safari-puppeteer

Control a **local, real Safari** with the Puppeteer API, backed by
`safaridriver` (W3C WebDriver) and AppleScript.

> The npm package is **`safari-puppeteer`**; the repository is
> `yevbar/puppeteer-safari`. The `puppeteer-safari` name on npm is taken by an
> unrelated placeholder package.

```bash
npm install safari-puppeteer
```

ESM-only, macOS-only, Node 18+. TypeScript consumers need `@types/node`
installed (the public types expose `Buffer` and extend `EventEmitter`) — any
Node TypeScript project already has it.

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
| `page.setRequestInterception()` | Classic WebDriver has no network layer | Local proxy, or stub `fetch` in-page |
| `page.setUserAgent()` | No capability or endpoint exists | Develop → User Agent menu |
| `page.emulate()` / `emulateMediaFeatures()` | No CDP Emulation domain | `setViewport`, or a real device/simulator |
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

## Why not WebDriver BiDi?

BiDi is the protocol that would let Puppeteer drive Safari properly, and
Puppeteer already supports a BiDi transport. But as of **Safari 18.6 / macOS
15.6**, `safaridriver` does not implement it: there is no `--bidi` flag and no
`webSocketUrl` capability. Upstream in WebKit, the `session`, `script`,
`network`, and `input` BiDi modules are still open bugs, and the WebSocket
server that does exist is the libsoup implementation used by WebKitGTK/WPE, not
by Apple's driver.

So classic WebDriver is not a shortcut here — it is the only option. If Apple
ships BiDi, the `src/api/` layer can be repointed at it without changing the
public API.

Note also that Safari 27 / STP 247 added `safaridriver --mcp`, an official MCP
server with network and console inspection. If you want those specific
capabilities and can require a beta Safari, that is worth a look.

## Development

```bash
npm run doctor            # check the environment
npm test                  # unit tests, no Safari needed
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

macOS with Safari. Node 18+. Tested against Safari 18.6 on macOS 15.6.

## License

MIT
