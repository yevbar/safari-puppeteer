import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';

import type { SafariApp } from '../applescript/safari.ts';
import type { BackendFeature, PageBackend } from '../backend/types.ts';
import { SafariPuppeteerError, UnsupportedOperationError } from '../common/errors.ts';
import { poll, sleep } from '../common/util.ts';
import type { Rect, WebDriverClient, WebDriverCookie } from '../webdriver/client.ts';
import { ElementHandle, JSHandle } from './JSHandle.ts';
import { Keyboard, Mouse, Touchscreen } from './Input.ts';

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  isLandscape?: boolean;
}

export interface WaitForOptions {
  timeout?: number;
  /**
   * Accepted for API compatibility. Classic WebDriver blocks navigation calls
   * until the document is ready and exposes no network-idle signal, so only
   * `'load'` and `'domcontentloaded'` are meaningful; `networkidle*` values
   * fall back to a short quiet-period heuristic.
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
}

export interface ScreenshotOptions {
  path?: string;
  encoding?: 'binary' | 'base64';
  /**
   * Capture the whole scrollable page. Emulated by resizing on the WebDriver
   * backend; native on the MCP backend.
   */
  fullPage?: boolean;
  /** Capture a specific region, in page coordinates. */
  clip?: Rect;
}

export interface ConsoleMessage {
  type: string;
  text: string;
  /** Best-effort location; WebDriver gives us no stack, so this is from Error(). */
  location?: { url: string; lineNumber?: number };
}

export interface Dialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface Cookie extends WebDriverCookie {}

/**
 * A Safari tab, presented with Puppeteer's `Page` API.
 *
 * Page owns the protocol-independent behaviour — poll loops, `waitUntil`
 * handling, init-script replay, event plumbing — and delegates every protocol
 * call to a {@link PageBackend}. What a given backend cannot do it declares
 * through `supports()`, so the resulting error names the backend and the
 * alternative instead of surfacing as a protocol failure.
 */
export class Page extends EventEmitter {
  #backend: PageBackend;
  #safari: SafariApp;
  #handle: string;
  #closed = false;
  #defaultTimeout = 30_000;
  #defaultNavigationTimeout: number | null = null;
  #viewport: Viewport | null = null;

  #consolePoller: NodeJS.Timeout | null = null;
  #dialogPoller: NodeJS.Timeout | null = null;
  /** Scripts re-injected after every navigation, as `evaluateOnNewDocument` promises. */
  #initScripts: string[] = [];

  #keyboard: Keyboard | null;
  #mouse: Mouse | null;
  #touchscreen: Touchscreen | null;

  constructor(backend: PageBackend, handle: string, safari: SafariApp) {
    super();
    this.#backend = backend;
    this.#handle = handle;
    this.#safari = safari;

    // The input classes drive the W3C Actions API directly. A backend without
    // it exposes no keyboard/mouse rather than a silently degraded one.
    const client = rawClient(backend);
    this.#keyboard = client ? new Keyboard(client) : null;
    this.#mouse = client ? new Mouse(client) : null;
    this.#touchscreen = client ? new Touchscreen(client) : null;

    // Console/dialog capture costs a poll loop each, so only run them when
    // somebody is actually listening.
    this.on('newListener', (event: string) => {
      if (event === 'console') void this.#startConsolePolling();
      if (event === 'dialog') this.#startDialogPolling();
    });
  }

  /** The backend driving this page. */
  get backend(): PageBackend {
    return this.#backend;
  }

  /** Whether the backend implements a capability. */
  supports(feature: BackendFeature): boolean {
    return this.#backend.supports(feature);
  }

  /** The underlying window/tab handle. */
  get windowHandle(): string {
    return this.#handle;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Low-level escape hatch: the raw WebDriver client. */
  get client(): WebDriverClient {
    const client = rawClient(this.#backend);
    if (client === null) {
      throw new UnsupportedOperationError(
        'page.client',
        `The "${this.#backend.name}" backend does not speak WebDriver, so there is no client to expose.`,
        "Use page.backend for backend-specific access, or launch with backend: 'webdriver'.",
      );
    }
    return client;
  }

  /** Low-level escape hatch: AppleScript control of the Safari app. */
  get safari(): SafariApp {
    return this.#safari;
  }

  get keyboard(): Keyboard {
    return this.#requireInput(this.#keyboard, 'page.keyboard');
  }

  get mouse(): Mouse {
    return this.#requireInput(this.#mouse, 'page.mouse');
  }

  get touchscreen(): Touchscreen {
    return this.#requireInput(this.#touchscreen, 'page.touchscreen');
  }

  #requireInput<T>(value: T | null, api: string): T {
    if (value === null) {
      throw new UnsupportedOperationError(
        api,
        `The "${this.#backend.name}" backend has no W3C Actions API, so low-level input is unavailable.`,
        'Use the selector-level helpers (page.click, page.type, page.hover), which every backend implements.',
      );
    }
    return value;
  }

  /**
   * Make this page's window the active one.
   *
   * Every public method calls this first. That is what lets several `Page`
   * objects coexist over a single-session driver.
   */
  async bringToDriver(): Promise<void> {
    this.#assertOpen();
    await this.#backend.activate();
  }

  #require(feature: BackendFeature, api: string, alternative: string): void {
    if (!this.#backend.supports(feature)) {
      throw new UnsupportedOperationError(
        api,
        `The "${this.#backend.name}" backend does not support ${feature}.`,
        alternative,
      );
    }
  }

  // --- Timeouts --------------------------------------------------------------

  setDefaultTimeout(timeout: number): void {
    this.#defaultTimeout = timeout;
  }

  setDefaultNavigationTimeout(timeout: number): void {
    this.#defaultNavigationTimeout = timeout;
  }

  get #navTimeout(): number {
    return this.#defaultNavigationTimeout ?? this.#defaultTimeout;
  }

  // --- Navigation ------------------------------------------------------------

  async goto(url: string, options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#backend.navigate(url, options.timeout ?? this.#navTimeout);
    await this.#afterNavigation(options);
    await this.#assertNavigated(url);
    // Puppeteer returns an HTTPResponse here; neither backend exposes response
    // metadata, so null is the honest answer.
    return null;
  }

  async reload(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#backend.reload();
    await this.#afterNavigation(options);
    await this.#assertNavigated();
    return null;
  }

  async goBack(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#backend.back();
    await this.#afterNavigation(options);
    await this.#assertNavigated();
    return null;
  }

  async goForward(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#backend.forward();
    await this.#afterNavigation(options);
    await this.#assertNavigated();
    return null;
  }

  /**
   * Fail loudly when a navigation did not actually reach the page.
   *
   * Neither backend reports transport failures: a refused connection or a DNS
   * miss returns success and leaves you on Safari's error page, so a script
   * carries on against the wrong document. Puppeteer throws here, and so do we.
   *
   * Detection is by document origin, not by title — Safari's error page is
   * served from `safari-resource:`, which no real page can occupy. Matching on
   * the title "Failed to open page" would misfire on any site that happens to
   * use it, which is exactly the false positive worth avoiding. A refused
   * connection is the other shape: the WebDriver backend stays on `about:blank`
   * rather than rendering an error page.
   *
   * An HTTP error status is deliberately *not* a failure. A 404 is a real
   * response and Puppeteer resolves for it too.
   */
  async #assertNavigated(requested?: string): Promise<void> {
    const state = await this.#backend
      .evaluate<{ href: string; protocol: string; text: string }>(
        () => ({
          href: location.href,
          protocol: location.protocol,
          text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        }),
        [],
      )
      .catch(() => null);

    if (state === null) return; // Cannot tell; better to proceed than to guess.

    const target = requested === undefined ? 'the page' : requested;

    if (state.protocol === 'safari-resource:') {
      throw new SafariPuppeteerError(
        `Navigation to ${target} failed — Safari displayed its error page.` +
          (state.text ? `\nSafari said: ${state.text}` : ''),
      );
    }

    if (
      requested !== undefined &&
      state.href === 'about:blank' &&
      !requested.startsWith('about:')
    ) {
      throw new SafariPuppeteerError(
        `Navigation to ${requested} failed — Safari stayed on about:blank, which usually means ` +
          'the connection was refused or the host is unreachable.',
      );
    }
  }

  /** Re-establish per-document state and honour `waitUntil`. */
  async #afterNavigation(options: WaitForOptions): Promise<void> {
    this.#backend.onNavigated();
    const timeout = options.timeout ?? this.#navTimeout;
    const waitUntil = options.waitUntil ?? 'load';

    if (waitUntil === 'load' || waitUntil.startsWith('networkidle')) {
      await this.#waitForReadyState('complete', timeout);
    } else {
      await this.#waitForReadyState('interactive', timeout);
    }

    if (waitUntil.startsWith('networkidle')) {
      // There is no request-count signal here. Approximate it with a quiet
      // period once readyState is stable.
      await sleep(500);
    }

    await this.#reinstallInitScripts();
    if (this.listenerCount('console') > 0) await this.#backend.prepareConsole();
  }

  async #waitForReadyState(target: 'interactive' | 'complete', timeout: number): Promise<void> {
    const acceptable = target === 'complete' ? ['complete'] : ['interactive', 'complete'];
    await poll(
      async () => {
        const state = await this.#backend.evaluate<string>(() => document.readyState, []);
        return acceptable.includes(state) ? true : null;
      },
      { timeout, interval: 50, message: `Waiting for document.readyState to reach "${target}"` },
    );
  }

  /**
   * Wait for the next navigation to finish.
   *
   * Implemented by watching for the document identity to change, since there is
   * no navigation event to subscribe to.
   */
  async waitForNavigation(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    const timeout = options.timeout ?? this.#navTimeout;
    const before = await this.url().catch(() => '');

    await poll(
      async () => {
        const state = await this.#backend.evaluate<string>(() => document.readyState, []);
        const now = await this.#backend.currentUrl();
        return now !== before && state === 'complete' ? true : null;
      },
      { timeout, interval: 50, message: 'Waiting for navigation' },
    );

    this.#backend.onNavigated();
    await this.#reinstallInitScripts();
    return null;
  }

  async url(): Promise<string> {
    await this.bringToDriver();
    return this.#backend.currentUrl();
  }

  async title(): Promise<string> {
    await this.bringToDriver();
    return this.#backend.currentTitle();
  }

  /** Full serialized HTML of the current document. */
  async content(): Promise<string> {
    await this.bringToDriver();
    return this.#backend.evaluate<string>(
      () => new XMLSerializer().serializeToString(document),
      [],
    );
  }

  /** Replace the document's markup, as `page.setContent` does. */
  async setContent(html: string, options: WaitForOptions = {}): Promise<void> {
    await this.bringToDriver();
    await this.#backend.evaluate(
      (markup: string) => {
        document.open();
        document.write(markup);
        document.close();
      },
      [html],
    );
    await this.#waitForReadyState('complete', options.timeout ?? this.#navTimeout);
    await this.#reinstallInitScripts();
  }

  // --- Evaluation ------------------------------------------------------------

  async evaluate<T = unknown>(fn: Function | string, ...args: unknown[]): Promise<T> {
    await this.bringToDriver();
    return this.#backend.evaluate<T>(fn, args);
  }

  async evaluateHandle(fn: Function | string, ...args: unknown[]): Promise<JSHandle> {
    this.#require('elementHandles', 'page.evaluateHandle()', 'Use page.evaluate() and return a serializable value.');
    await this.bringToDriver();
    return this.#backend.evaluateHandle(fn, args);
  }

  /**
   * Register a script to run before any page script, on every navigation.
   *
   * Neither backend can inject before document start, so this runs immediately
   * *after* the navigation completes. Scripts that must beat page code (e.g.
   * stubbing `navigator` before a framework reads it) will not work.
   */
  async evaluateOnNewDocument(fn: Function | string, ...args: unknown[]): Promise<void> {
    const source =
      typeof fn === 'string' ? fn : `(${fn.toString()}).apply(null, ${JSON.stringify(args)});`;
    this.#initScripts.push(source);
    await this.#backend.evaluateQuietly(source);
  }

  async #reinstallInitScripts(): Promise<void> {
    for (const source of this.#initScripts) {
      await this.#backend.evaluateQuietly(source);
    }
  }

  // --- Selectors -------------------------------------------------------------

  async $(selector: string): Promise<ElementHandle | null> {
    this.#require('elementHandles', 'page.$()', 'Use page.$eval(), which needs no handle.');
    await this.bringToDriver();
    return this.#backend.find(selector);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    this.#require('elementHandles', 'page.$$()', 'Use page.$$eval(), which needs no handle.');
    await this.bringToDriver();
    return this.#backend.findAll(selector);
  }

  /** XPath query, mirroring Puppeteer's `page.$x`. */
  async $x(expression: string): Promise<ElementHandle[]> {
    this.#require('xpath', 'page.$x()', 'Use document.evaluate() inside page.evaluate().');
    await this.bringToDriver();
    return this.#backend.findAllByXPath(expression);
  }

  /**
   * Evaluated in-page rather than through an element handle, so it works on
   * every backend.
   */
  async $eval<T = unknown>(selector: string, fn: Function, ...args: unknown[]): Promise<T> {
    await this.bringToDriver();
    return this.#backend.evaluate<T>(
      (sel: string, source: string, rest: unknown[]) => {
        const node = document.querySelector(sel);
        if (node === null) throw new Error(`No element matches selector "${sel}".`);
        // eslint-disable-next-line no-eval
        const callback = eval(`(${source})`);
        return callback(node, ...rest);
      },
      [selector, fn.toString(), args],
    );
  }

  async $$eval<T = unknown>(selector: string, fn: Function, ...args: unknown[]): Promise<T> {
    await this.bringToDriver();
    return this.#backend.evaluate<T>(
      (sel: string, source: string, rest: unknown[]) => {
        const nodes = Array.from(document.querySelectorAll(sel));
        // eslint-disable-next-line no-eval
        const callback = eval(`(${source})`);
        return callback(nodes, ...rest);
      },
      [selector, fn.toString(), args],
    );
  }

  // --- Waiting ---------------------------------------------------------------

  /**
   * Existence and visibility are checked in-page so this works on every
   * backend. The returned handle is null when the backend has no element
   * references — the wait itself still works.
   */
  async waitForSelector(
    selector: string,
    options: { timeout?: number; visible?: boolean; hidden?: boolean } = {},
  ): Promise<ElementHandle | null> {
    const timeout = options.timeout ?? this.#defaultTimeout;
    await this.bringToDriver();

    const state = (sel: string): Promise<'missing' | 'hidden' | 'visible'> =>
      this.#backend.evaluate<'missing' | 'hidden' | 'visible'>((query: string) => {
        const node = document.querySelector(query);
        if (node === null) return 'missing';
        const element = node as Element & {
          checkVisibility?: (options?: Record<string, boolean>) => boolean;
        };
        if (typeof element.checkVisibility === 'function') {
          if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
            return 'hidden';
          }
        } else {
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility !== 'visible') return 'hidden';
          if (Number.parseFloat(style.opacity) === 0) return 'hidden';
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? 'visible' : 'hidden';
      }, [sel]);

    if (options.hidden) {
      await poll(
        async () => ((await state(selector)) === 'visible' ? null : true),
        { timeout, message: `Waiting for selector "${selector}" to be hidden` },
      );
      return null;
    }

    await poll(
      async () => {
        const current = await state(selector);
        if (current === 'missing') return null;
        if (options.visible && current !== 'visible') return null;
        return true;
      },
      { timeout, message: `Waiting for selector "${selector}"` },
    );

    return this.#backend.supports('elementHandles') ? this.#backend.find(selector) : null;
  }

  /** Wait until `fn` returns a truthy value in the page. */
  async waitForFunction<T = unknown>(
    fn: Function | string,
    options: { timeout?: number; polling?: number } = {},
    ...args: unknown[]
  ): Promise<JSHandle | null> {
    const timeout = options.timeout ?? this.#defaultTimeout;
    await poll(
      async () => {
        const value = await this.evaluate<unknown>(fn, ...args);
        return value ? true : null;
      },
      { timeout, interval: options.polling ?? 50, message: 'Waiting for function to return truthy' },
    );
    return this.#backend.supports('elementHandles') ? this.evaluateHandle(fn, ...args) : null;
  }

  async waitForXPath(expression: string, options: { timeout?: number } = {}): Promise<ElementHandle> {
    this.#require('xpath', 'page.waitForXPath()', 'Use page.waitForFunction() with document.evaluate().');
    const timeout = options.timeout ?? this.#defaultTimeout;
    return poll(
      async () => {
        const [first] = await this.$x(expression);
        return first ?? null;
      },
      { timeout, message: `Waiting for XPath "${expression}"` },
    );
  }

  // --- Convenience interaction ----------------------------------------------

  async click(selector: string, options: { button?: 'left' | 'middle' | 'right'; clickCount?: number; delay?: number } = {}): Promise<void> {
    await this.waitForSelector(selector);
    await this.#backend.click(selector, options);
  }

  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> {
    await this.waitForSelector(selector);
    await this.#backend.type(selector, text, options);
  }

  async hover(selector: string): Promise<void> {
    await this.waitForSelector(selector);
    await this.#backend.hover(selector);
  }

  async focus(selector: string): Promise<void> {
    await this.waitForSelector(selector);
    await this.#backend.focus(selector);
  }

  async tap(selector: string): Promise<void> {
    await this.waitForSelector(selector);
    await this.#backend.tap(selector);
  }

  async select(selector: string, ...values: string[]): Promise<string[]> {
    await this.waitForSelector(selector);
    return this.#backend.select(selector, values);
  }

  /** Inject a `<script>` tag and resolve once it has loaded. */
  async addScriptTag(options: { url?: string; content?: string; type?: string }): Promise<void> {
    await this.bringToDriver();

    if (options.url) {
      const token = await this.#backend.evaluate<string>(
        (src: string, type: string | null) => {
          const marker = `__sp_script_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const script = document.createElement('script');
          script.src = src;
          if (type) script.type = type;
          script.onload = () => {
            (window as unknown as Record<string, unknown>)[marker] = 'loaded';
          };
          script.onerror = () => {
            (window as unknown as Record<string, unknown>)[marker] = 'error';
          };
          document.head.appendChild(script);
          return marker;
        },
        [options.url, options.type ?? null],
      );

      const result = await poll(
        () =>
          this.#backend.evaluate<string | null>(
            (marker: string) =>
              ((window as unknown as Record<string, unknown>)[marker] as string) ?? null,
            [token],
          ),
        { timeout: this.#defaultTimeout, interval: 50, message: `Waiting for script ${options.url}` },
      );
      if (result === 'error') {
        throw new SafariPuppeteerError(`Failed to load script: ${options.url}`);
      }
      return;
    }

    await this.#backend.evaluate(
      (content: string, type: string | null) => {
        const script = document.createElement('script');
        script.textContent = content;
        if (type) script.type = type;
        document.head.appendChild(script);
      },
      [options.content ?? '', options.type ?? null],
    );
  }

  async addStyleTag(options: { url?: string; content?: string }): Promise<void> {
    await this.bringToDriver();

    if (options.url) {
      const token = await this.#backend.evaluate<string>((href: string) => {
        const marker = `__sp_style_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = () => {
          (window as unknown as Record<string, unknown>)[marker] = 'loaded';
        };
        link.onerror = () => {
          (window as unknown as Record<string, unknown>)[marker] = 'error';
        };
        document.head.appendChild(link);
        return marker;
      }, [options.url]);

      const result = await poll(
        () =>
          this.#backend.evaluate<string | null>(
            (marker: string) =>
              ((window as unknown as Record<string, unknown>)[marker] as string) ?? null,
            [token],
          ),
        { timeout: this.#defaultTimeout, interval: 50, message: `Waiting for stylesheet ${options.url}` },
      );
      if (result === 'error') {
        throw new SafariPuppeteerError(`Failed to load stylesheet: ${options.url}`);
      }
      return;
    }

    await this.#backend.evaluate((content: string) => {
      const style = document.createElement('style');
      style.textContent = content;
      document.head.appendChild(style);
    }, [options.content ?? '']);
  }

  // --- Frames ----------------------------------------------------------------

  /**
   * Enter an iframe. Subsequent queries and evaluations target it.
   *
   * WebDriver models frames as driver state rather than as objects, so this is
   * a mode switch rather than Puppeteer's `frame.$()` object model.
   */
  async enterFrame(target: number | ElementHandle): Promise<void> {
    this.#require('frames', 'page.enterFrame()', 'Evaluate inside the frame with page.evaluate() instead.');
    await this.bringToDriver();
    await this.#backend.enterFrame(target);
  }

  /** Step out one frame level. */
  async exitFrame(): Promise<void> {
    this.#require('frames', 'page.exitFrame()', 'Evaluate inside the frame with page.evaluate() instead.');
    await this.bringToDriver();
    await this.#backend.exitFrame();
  }

  /** Return to the top-level document. */
  async exitAllFrames(): Promise<void> {
    this.#require('frames', 'page.exitAllFrames()', 'Evaluate inside the frame with page.evaluate() instead.');
    this.#assertOpen();
    await this.#backend.exitAllFrames();
  }

  /** URLs of the frames in the current document, for discovery. */
  async frameUrls(): Promise<string[]> {
    await this.bringToDriver();
    return this.#backend.evaluate<string[]>(
      () =>
        Array.from(document.querySelectorAll('iframe,frame')).map(
          (frame) => (frame as HTMLIFrameElement).src || '',
        ),
      [],
    );
  }

  // --- Viewport & window -----------------------------------------------------

  viewport(): Viewport | null {
    return this.#viewport;
  }

  /**
   * Resize so the *viewport* matches `width`/`height`.
   *
   * `deviceScaleFactor`, `isMobile`, `hasTouch` and `isLandscape` cannot be
   * emulated in real Safari and are ignored.
   */
  async setViewport(viewport: Viewport): Promise<void> {
    await this.bringToDriver();
    await this.#backend.setViewport(viewport);
    this.#viewport = viewport;
  }

  /** Raw window rect in screen coordinates. */
  async windowRect(): Promise<Rect> {
    this.#require('windowRect', 'page.windowRect()', 'Use page.setViewport() to size the content area.');
    await this.bringToDriver();
    return this.#backend.windowRect();
  }

  async setWindowRect(rect: Partial<Rect>): Promise<Rect> {
    this.#require('windowRect', 'page.setWindowRect()', 'Use page.setViewport() to size the content area.');
    await this.bringToDriver();
    return this.#backend.setWindowRect(rect);
  }

  async maximize(): Promise<void> {
    this.#require('windowRect', 'page.maximize()', 'Use page.setViewport() with explicit dimensions.');
    await this.bringToDriver();
    await this.#backend.maximize();
  }

  /** Bring the Safari application itself to the foreground. */
  async bringToFront(): Promise<void> {
    await this.bringToDriver();
    await this.#safari.activate();
  }

  // --- Screenshots -----------------------------------------------------------

  screenshot(options?: ScreenshotOptions & { encoding?: 'binary' }): Promise<Buffer>;
  screenshot(options: ScreenshotOptions & { encoding: 'base64' }): Promise<string>;
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer | string> {
    await this.bringToDriver();

    if (options.clip) {
      throw new UnsupportedOperationError(
        'page.screenshot({ clip })',
        'Neither backend has a region-capture command, and Safari exposes no compositor access.',
        'Screenshot a specific element with elementHandle.screenshot(), or crop the returned PNG yourself.',
      );
    }

    const base64 = await this.#backend.screenshot(options);
    const buffer = Buffer.from(base64, 'base64');
    if (options.path) await writeFile(options.path, buffer);
    return options.encoding === 'base64' ? base64 : buffer;
  }

  /** Not available: safaridriver does not implement `POST /print`. */
  pdf(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.pdf()',
        'safaridriver does not implement the WebDriver `print` endpoint (SeleniumHQ/selenium#13815).',
        "Trigger Safari's own print flow with AppleScript via page.safari, or render the PDF server-side.",
      ),
    );
  }

  // --- Cookies ---------------------------------------------------------------

  /**
   * Cookies for the current document's domain.
   *
   * Unlike Puppeteer, WebDriver cannot list cookies for arbitrary URLs — the
   * driver only sees the active document — so `urls` arguments are rejected
   * rather than silently ignored.
   */
  async cookies(...urls: string[]): Promise<Cookie[]> {
    this.#require('cookies', 'page.cookies()', 'Read document.cookie via page.evaluate(), accepting that httpOnly cookies are invisible.');
    if (urls.length > 0) {
      throw new UnsupportedOperationError(
        'page.cookies(...urls)',
        'WebDriver only exposes cookies for the currently loaded document.',
        'Navigate to each origin and call page.cookies() with no arguments.',
      );
    }
    await this.bringToDriver();
    return this.#backend.cookies();
  }

  async setCookie(...cookies: Cookie[]): Promise<void> {
    this.#require('cookies', 'page.setCookie()', 'Assign document.cookie via page.evaluate().');
    await this.bringToDriver();
    for (const cookie of cookies) {
      await this.#backend.addCookie(cookie);
    }
  }

  async deleteCookie(...cookies: Array<{ name: string }>): Promise<void> {
    this.#require('cookies', 'page.deleteCookie()', 'Expire the cookie via document.cookie in page.evaluate().');
    await this.bringToDriver();
    for (const cookie of cookies) {
      await this.#backend.deleteCookie(cookie.name);
    }
  }

  async deleteAllCookies(): Promise<void> {
    this.#require('cookies', 'page.deleteAllCookies()', 'Expire cookies via document.cookie in page.evaluate().');
    await this.bringToDriver();
    await this.#backend.deleteAllCookies();
  }

  // --- Observation -----------------------------------------------------------

  /**
   * Read-only network inspection. Available only on backends that have any —
   * the WebDriver one rejects with an explanation.
   */
  async networkRequests(options: { clear?: boolean; filter?: string } = {}): Promise<unknown> {
    await this.bringToDriver();
    return this.#backend.networkRequests(options);
  }

  /** Override the CSS media type (`'screen'`, `'print'`, `''` to clear). */
  async emulateMediaType(media: string): Promise<void> {
    await this.bringToDriver();
    await this.#backend.setEmulatedMediaType(media);
  }

  async #startConsolePolling(): Promise<void> {
    if (this.#consolePoller !== null) return;
    await this.#backend.prepareConsole();

    this.#consolePoller = setInterval(() => {
      void (async () => {
        if (this.#closed) return;
        try {
          for (const message of await this.#backend.drainConsole()) {
            const consoleMessage: ConsoleMessage = {
              type: message.type,
              text: message.text,
              location: { url: message.url, lineNumber: message.line },
            };
            this.emit('console', consoleMessage);
            if (message.type === 'error') this.emit('pageerror', new Error(message.text));
          }
        } catch {
          // Navigation in flight, or a dialog is blocking; the hook is
          // reinstalled by #afterNavigation.
        }
      })();
    }, 250);
    this.#consolePoller.unref();
  }

  /**
   * Dialog handling is polled. On the WebDriver backend a JS dialog blocks the
   * page and every other command starts failing with `unexpected alert open`
   * until it is handled — so if you use `alert()`/`confirm()`, attach a
   * `dialog` listener or calls will start erroring.
   */
  #startDialogPolling(): void {
    if (this.#dialogPoller !== null) return;
    if (!this.#backend.supports('dialogs')) return;

    this.#dialogPoller = setInterval(() => {
      void (async () => {
        if (this.#closed) return;
        const dialog = await this.#backend.pendingDialog().catch(() => null);
        if (dialog === null) return;

        let handled = false;
        const tracked: Dialog = {
          ...dialog,
          accept: async (promptText?: string) => {
            handled = true;
            await dialog.accept(promptText);
          },
          dismiss: async () => {
            handled = true;
            await dialog.dismiss();
          },
        };

        this.emit('dialog', tracked);

        // Puppeteer requires the listener to handle the dialog; if nobody does,
        // dismiss it so the session does not wedge.
        setTimeout(() => {
          if (!handled) void tracked.dismiss().catch(() => {});
        }, 5000).unref();
      })();
    }, 200);
    this.#dialogPoller.unref();
  }

  // --- Explicitly unsupported ------------------------------------------------

  setRequestInterception(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.setRequestInterception()',
        "No Safari automation channel can modify traffic. Classic WebDriver has no network layer at all; safaridriver --mcp observes requests but cannot intercept them; and WebDriver BiDi's `network` module — the one interface that could — is still missing from safaridriver (verified on Safari 26.6: `network` reports \"domain was not found\").",
        "For read-only inspection use the MCP backend and page.networkRequests(). To actually modify traffic, put a local proxy (mitmproxy) in front of Safari, or stub `window.fetch`/`XMLHttpRequest` with page.evaluateOnNewDocument().",
      ),
    );
  }

  setUserAgent(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.setUserAgent()',
        'safaridriver exposes no user-agent capability or endpoint.',
        "Use Safari's Develop > User Agent menu manually, or run against a device/simulator with the desired UA.",
      ),
    );
  }

  emulate(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.emulate()',
        'Real Safari has no device-emulation surface; there is no CDP Emulation domain.',
        'Use page.setViewport() for size, or drive a real device/simulator via safaridriver capabilities (safari:deviceType, safari:useSimulator).',
      ),
    );
  }

  emulateMediaFeatures(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.emulateMediaFeatures()',
        "No CDP Emulation domain is available in real Safari. The MCP server's set_emulated_media tool is not a substitute: it takes a CSS media *type* ('screen', 'print') only, not features like prefers-color-scheme.",
        'Use page.emulateMediaType() on the MCP backend for the type, or override the media query in-page by injecting CSS with page.evaluate().',
      ),
    );
  }

  setOfflineMode(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.setOfflineMode()',
        'Network conditions cannot be controlled through safaridriver.',
        'Use macOS Network Link Conditioner, or stub `navigator.onLine` and fetch in-page.',
      ),
    );
  }

  // --- Lifecycle -------------------------------------------------------------

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#consolePoller) clearInterval(this.#consolePoller);
    if (this.#dialogPoller) clearInterval(this.#dialogPoller);
    this.#consolePoller = null;
    this.#dialogPoller = null;

    await this.#backend.close();
    this.emit('close');
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SafariPuppeteerError('This page has been closed.');
    }
  }
}

/**
 * The WebDriver client behind a backend, when there is one.
 *
 * Structural rather than an `instanceof` check so the backend module does not
 * have to be imported here, which would make the dependency cycle real.
 */
function rawClient(backend: PageBackend): WebDriverClient | null {
  const candidate = (backend as unknown as { client?: WebDriverClient }).client;
  return candidate ?? null;
}
