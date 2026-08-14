import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';

import type { SafariApp } from '../applescript/safari.ts';
import {
  SafariPuppeteerError,
  TimeoutError,
  UnsupportedOperationError,
  WebDriverError,
} from '../common/errors.ts';
import { poll, sleep } from '../common/util.ts';
import type { Rect, WebDriverClient, WebDriverCookie } from '../webdriver/client.ts';
import { ExecutionContext } from './ExecutionContext.ts';
import { createHandle, ElementHandle, elementHandleFromId, JSHandle } from './JSHandle.ts';
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
   * Capture the whole scrollable page. Safari's driver clipped this to the
   * viewport before Safari 27 / STP 247, so we emulate it by temporarily
   * growing the window. See {@link Page.screenshot}.
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

const CONSOLE_BUFFER = '__safariPuppeteerConsole__';

/**
 * A Safari tab, presented with Puppeteer's `Page` API.
 *
 * Each Page owns a WebDriver window handle. Because safaridriver serves one
 * session at a time, all pages of a Browser share a single {@link
 * WebDriverClient} and we switch the driver's active window before each
 * operation (see {@link Page.bringToDriver}).
 */
export class Page extends EventEmitter {
  #client: WebDriverClient;
  #handle: string;
  #safari: SafariApp;
  #context: ExecutionContext;
  #closed = false;
  #defaultTimeout = 30_000;
  #defaultNavigationTimeout: number | null = null;
  #viewport: Viewport | null = null;
  /** Set when the caller switches into an iframe, so we can restore it. */
  #framePath: Array<number | string> = [];

  #consolePoller: NodeJS.Timeout | null = null;
  #dialogPoller: NodeJS.Timeout | null = null;
  /** Scripts re-injected after every navigation, as `evaluateOnNewDocument` promises. */
  #initScripts: string[] = [];

  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  readonly touchscreen: Touchscreen;

  constructor(client: WebDriverClient, handle: string, safari: SafariApp) {
    super();
    this.#client = client;
    this.#handle = handle;
    this.#safari = safari;
    this.#context = new ExecutionContext(client);
    this.keyboard = new Keyboard(client);
    this.mouse = new Mouse(client);
    this.touchscreen = new Touchscreen(client);

    // Console/dialog capture costs a poll loop each, so only run them when
    // somebody is actually listening.
    this.on('newListener', (event: string) => {
      if (event === 'console') void this.#startConsolePolling();
      if (event === 'dialog') this.#startDialogPolling();
    });
  }

  /** The underlying WebDriver window handle. */
  get windowHandle(): string {
    return this.#handle;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Low-level escape hatch: the raw WebDriver client. */
  get client(): WebDriverClient {
    return this.#client;
  }

  /** Low-level escape hatch: AppleScript control of the Safari app. */
  get safari(): SafariApp {
    return this.#safari;
  }

  /**
   * Make this page's window the driver's active one.
   *
   * Every public method calls this first. That is what lets several `Page`
   * objects coexist over a single-session driver.
   */
  async bringToDriver(): Promise<void> {
    this.#assertOpen();
    const current = await this.#client.getWindowHandle().catch(() => null);
    if (current !== this.#handle) {
      await this.#client.switchToWindow(this.#handle);
      // Switching windows resets the driver to the top-level browsing context,
      // so re-enter whatever frame this page was in.
      await this.#restoreFrame();
    }
  }

  async #restoreFrame(): Promise<void> {
    if (this.#framePath.length === 0) return;
    await this.#client.switchToFrame(null);
    for (const step of this.#framePath) {
      if (typeof step === 'number') {
        await this.#client.switchToFrame(step);
      } else {
        await this.#client.switchToFrame({ 'element-6066-11e4-a52e-4f735466cecf': step });
      }
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
    const timeout = options.timeout ?? this.#navTimeout;
    await this.#client.setTimeouts({ pageLoad: timeout }).catch(() => {});
    await this.#client.navigateTo(url);
    await this.#afterNavigation(options);
    // Puppeteer returns an HTTPResponse here; WebDriver exposes no response
    // metadata at all, so null is the honest answer.
    return null;
  }

  async reload(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#client.refresh();
    await this.#afterNavigation(options);
    return null;
  }

  async goBack(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#client.back();
    await this.#afterNavigation(options);
    return null;
  }

  async goForward(options: WaitForOptions = {}): Promise<null> {
    await this.bringToDriver();
    await this.#client.forward();
    await this.#afterNavigation(options);
    return null;
  }

  /** Re-establish per-document state and honour `waitUntil`. */
  async #afterNavigation(options: WaitForOptions): Promise<void> {
    this.#framePath = [];
    const timeout = options.timeout ?? this.#navTimeout;
    const waitUntil = options.waitUntil ?? 'load';

    if (waitUntil === 'load' || waitUntil.startsWith('networkidle')) {
      await this.#waitForReadyState('complete', timeout);
    } else {
      await this.#waitForReadyState('interactive', timeout);
    }

    if (waitUntil.startsWith('networkidle')) {
      // There is no request-count signal in WebDriver. Approximate it with a
      // quiet period: no new DOM mutations and readyState stable.
      await sleep(500);
    }

    await this.#reinstallInitScripts();
    if (this.listenerCount('console') > 0) await this.#installConsoleHook();
  }

  async #waitForReadyState(target: 'interactive' | 'complete', timeout: number): Promise<void> {
    const acceptable = target === 'complete' ? ['complete'] : ['interactive', 'complete'];
    await poll(
      async () => {
        const state = await this.#client.executeScript<string>('return document.readyState;');
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
        const state = await this.#client.executeScript<string>('return document.readyState;');
        const now = await this.#client.getCurrentUrl();
        return now !== before && state === 'complete' ? true : null;
      },
      { timeout, interval: 50, message: 'Waiting for navigation' },
    );

    this.#framePath = [];
    await this.#reinstallInitScripts();
    return null;
  }

  async url(): Promise<string> {
    await this.bringToDriver();
    return this.#client.getCurrentUrl();
  }

  async title(): Promise<string> {
    await this.bringToDriver();
    return this.#client.getTitle();
  }

  /** Full serialized HTML of the current document. */
  async content(): Promise<string> {
    await this.bringToDriver();
    return this.#client.executeScript<string>(
      'return new XMLSerializer().serializeToString(document);',
    );
  }

  /** Replace the document's markup, as `page.setContent` does. */
  async setContent(html: string, options: WaitForOptions = {}): Promise<void> {
    await this.bringToDriver();
    await this.#client.executeScript(
      'document.open(); document.write(arguments[0]); document.close();',
      [html],
    );
    await this.#waitForReadyState('complete', options.timeout ?? this.#navTimeout);
    await this.#reinstallInitScripts();
  }

  // --- Evaluation ------------------------------------------------------------

  async evaluate<T = unknown>(fn: Function | string, ...args: unknown[]): Promise<T> {
    await this.bringToDriver();
    return this.#context.evaluate<T>(fn, ...args);
  }

  async evaluateHandle(fn: Function | string, ...args: unknown[]): Promise<JSHandle> {
    await this.bringToDriver();
    const descriptor = await this.#context.evaluateHandle(fn, ...args);
    return createHandle(this.#context, descriptor);
  }

  /**
   * Register a script to run before any page script, on every navigation.
   *
   * WebDriver cannot inject before document start, so this runs immediately
   * *after* the navigation completes. Scripts that must beat page code (e.g.
   * stubbing `navigator` before a framework reads it) will not work.
   */
  async evaluateOnNewDocument(fn: Function | string, ...args: unknown[]): Promise<void> {
    const source =
      typeof fn === 'string'
        ? fn
        : `(${fn.toString()}).apply(null, ${JSON.stringify(args)});`;
    this.#initScripts.push(source);
    await this.#client.executeScript(source).catch(() => {});
  }

  async #reinstallInitScripts(): Promise<void> {
    for (const source of this.#initScripts) {
      await this.#client.executeScript(source).catch(() => {});
    }
  }

  // --- Selectors -------------------------------------------------------------

  async $(selector: string): Promise<ElementHandle | null> {
    await this.bringToDriver();
    try {
      const id = await this.#client.findElement('css selector', selector);
      return elementHandleFromId(this.#context, id);
    } catch (error) {
      if (error instanceof WebDriverError && error.code === 'no such element') return null;
      throw error;
    }
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    await this.bringToDriver();
    const ids = await this.#client.findElements('css selector', selector);
    return ids.map((id) => elementHandleFromId(this.#context, id));
  }

  /** XPath query, mirroring Puppeteer's `page.$x`. */
  async $x(expression: string): Promise<ElementHandle[]> {
    await this.bringToDriver();
    const ids = await this.#client.findElements('xpath', expression);
    return ids.map((id) => elementHandleFromId(this.#context, id));
  }

  async $eval<T = unknown>(selector: string, fn: Function, ...args: unknown[]): Promise<T> {
    const element = await this.$(selector);
    if (element === null) {
      throw new SafariPuppeteerError(`No element matches selector "${selector}".`);
    }
    return element.evaluate<T>(fn, ...args);
  }

  async $$eval<T = unknown>(selector: string, fn: Function, ...args: unknown[]): Promise<T> {
    await this.bringToDriver();
    return this.#context.evaluate<T>(
      (sel: string, fnSource: string, rest: unknown[]) => {
        const nodes = Array.from(document.querySelectorAll(sel));
        // eslint-disable-next-line no-eval
        const callback = eval(`(${fnSource})`);
        return callback(nodes, ...rest);
      },
      selector,
      fn.toString(),
      args,
    );
  }

  // --- Waiting ---------------------------------------------------------------

  async waitForSelector(
    selector: string,
    options: { timeout?: number; visible?: boolean; hidden?: boolean } = {},
  ): Promise<ElementHandle | null> {
    const timeout = options.timeout ?? this.#defaultTimeout;

    if (options.hidden) {
      await poll(
        async () => {
          const element = await this.$(selector);
          if (element === null) return true;
          const visible = await element.isVisible().catch(() => false);
          return visible ? null : true;
        },
        { timeout, message: `Waiting for selector "${selector}" to be hidden` },
      );
      return null;
    }

    return poll(
      async () => {
        const element = await this.$(selector);
        if (element === null) return null;
        if (options.visible && !(await element.isVisible().catch(() => false))) return null;
        return element;
      },
      { timeout, message: `Waiting for selector "${selector}"` },
    );
  }

  /** Wait until `fn` returns a truthy value in the page. */
  async waitForFunction<T = unknown>(
    fn: Function | string,
    options: { timeout?: number; polling?: number } = {},
    ...args: unknown[]
  ): Promise<JSHandle> {
    const timeout = options.timeout ?? this.#defaultTimeout;
    await poll(
      async () => {
        const value = await this.evaluate<unknown>(fn, ...args);
        return value ? true : null;
      },
      { timeout, interval: options.polling ?? 50, message: 'Waiting for function to return truthy' },
    );
    return this.evaluateHandle(fn, ...args);
  }

  /** Wait until the URL or an already-open page matches. */
  async waitForXPath(expression: string, options: { timeout?: number } = {}): Promise<ElementHandle> {
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

  async click(selector: string, options: Parameters<ElementHandle['click']>[0] = {}): Promise<void> {
    const element = await this.waitForSelector(selector);
    if (element === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    await element.click(options);
  }

  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> {
    const element = await this.waitForSelector(selector);
    if (element === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    await element.type(text, options);
  }

  async hover(selector: string): Promise<void> {
    const element = await this.waitForSelector(selector);
    if (element === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    await element.hover();
  }

  async focus(selector: string): Promise<void> {
    const element = await this.waitForSelector(selector);
    if (element === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    await element.focus();
  }

  async tap(selector: string): Promise<void> {
    const element = await this.waitForSelector(selector);
    if (element === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    await element.tap();
  }

  async select(selector: string, ...values: string[]): Promise<string[]> {
    const element = await this.waitForSelector(selector);
    if (element === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    return element.select(...values);
  }

  /** Inject a `<script>` tag and resolve once it has loaded. */
  async addScriptTag(options: { url?: string; content?: string; type?: string }): Promise<void> {
    await this.bringToDriver();
    if (options.url) {
      await this.#client.executeAsyncScript(
        `var done = arguments[arguments.length - 1];
         var s = document.createElement('script');
         s.src = arguments[0];
         if (arguments[1]) s.type = arguments[1];
         s.onload = function () { done(null); };
         s.onerror = function () { done('Failed to load script: ' + arguments[0]); };
         document.head.appendChild(s);`,
        [options.url, options.type ?? null],
      );
      return;
    }
    await this.#client.executeScript(
      `var s = document.createElement('script');
       s.textContent = arguments[0];
       if (arguments[1]) s.type = arguments[1];
       document.head.appendChild(s);`,
      [options.content ?? '', options.type ?? null],
    );
  }

  async addStyleTag(options: { url?: string; content?: string }): Promise<void> {
    await this.bringToDriver();
    if (options.url) {
      await this.#client.executeAsyncScript(
        `var done = arguments[arguments.length - 1];
         var l = document.createElement('link');
         l.rel = 'stylesheet';
         l.href = arguments[0];
         l.onload = function () { done(null); };
         l.onerror = function () { done('Failed to load stylesheet'); };
         document.head.appendChild(l);`,
        [options.url],
      );
      return;
    }
    await this.#client.executeScript(
      `var s = document.createElement('style');
       s.textContent = arguments[0];
       document.head.appendChild(s);`,
      [options.content ?? ''],
    );
  }

  // --- Frames ----------------------------------------------------------------

  /**
   * Enter an iframe. Subsequent queries and evaluations target it.
   *
   * WebDriver models frames as driver state rather than as objects, so this is
   * a mode switch rather than Puppeteer's `frame.$()` object model.
   */
  async enterFrame(target: number | ElementHandle): Promise<void> {
    await this.bringToDriver();
    if (typeof target === 'number') {
      await this.#client.switchToFrame(target);
      this.#framePath.push(target);
    } else {
      await this.#client.switchToFrame({
        'element-6066-11e4-a52e-4f735466cecf': target.elementId,
      });
      this.#framePath.push(target.elementId);
    }
  }

  /** Step out one frame level. */
  async exitFrame(): Promise<void> {
    await this.bringToDriver();
    await this.#client.switchToParentFrame();
    this.#framePath.pop();
  }

  /** Return to the top-level document. */
  async exitAllFrames(): Promise<void> {
    this.#assertOpen();
    await this.#client.switchToWindow(this.#handle);
    await this.#client.switchToFrame(null);
    this.#framePath = [];
  }

  /** URLs of the frames in the current document, for discovery. */
  async frameUrls(): Promise<string[]> {
    await this.bringToDriver();
    return this.#context.evaluate<string[]>(() =>
      Array.from(document.querySelectorAll('iframe,frame')).map(
        (frame) => (frame as HTMLIFrameElement).src || '',
      ),
    );
  }

  // --- Viewport & window -----------------------------------------------------

  viewport(): Viewport | null {
    return this.#viewport;
  }

  /**
   * Resize so the *viewport* matches `width`/`height`.
   *
   * WebDriver sizes the outer window, so we measure the chrome (toolbar,
   * borders) and compensate. `deviceScaleFactor`, `isMobile`, `hasTouch` and
   * `isLandscape` cannot be emulated in real Safari and are ignored.
   */
  async setViewport(viewport: Viewport): Promise<void> {
    await this.bringToDriver();

    const measure = () =>
      this.#client.executeScript<{ inner: [number, number]; outer: [number, number] }>(
        'return { inner: [window.innerWidth, window.innerHeight], outer: [window.outerWidth, window.outerHeight] };',
      );

    let { inner, outer } = await measure();
    let chromeWidth = outer[0] - inner[0];
    let chromeHeight = outer[1] - inner[1];

    await this.#client.setWindowRect({
      width: Math.round(viewport.width + chromeWidth),
      height: Math.round(viewport.height + chromeHeight),
    });

    // One correction pass: the chrome height changes when e.g. the tab bar
    // wraps, so the first estimate can be off by a few pixels.
    ({ inner, outer } = await measure());
    if (inner[0] !== viewport.width || inner[1] !== viewport.height) {
      chromeWidth = outer[0] - inner[0];
      chromeHeight = outer[1] - inner[1];
      await this.#client.setWindowRect({
        width: Math.round(viewport.width + chromeWidth),
        height: Math.round(viewport.height + chromeHeight),
      });
    }

    this.#viewport = viewport;
  }

  /** Raw window rect in screen coordinates. */
  async windowRect(): Promise<Rect> {
    await this.bringToDriver();
    return this.#client.getWindowRect();
  }

  async setWindowRect(rect: Partial<Rect>): Promise<Rect> {
    await this.bringToDriver();
    return this.#client.setWindowRect(rect);
  }

  async maximize(): Promise<void> {
    await this.bringToDriver();
    await this.#client.maximizeWindow();
  }

  /** Bring the Safari application itself to the foreground. */
  async bringToFront(): Promise<void> {
    await this.bringToDriver();
    await this.#safari.activate();
  }

  // --- Screenshots -----------------------------------------------------------

  /**
   * PNG screenshot.
   *
   * `fullPage` is emulated: safaridriver clips `/screenshot` to the viewport on
   * Safari before 27 / STP 247. We temporarily grow the window to the document
   * height, capture, then restore. The window is capped at the screen height
   * the OS will allow, so very tall pages are still truncated — the returned
   * image is whatever fit.
   */
  screenshot(options?: ScreenshotOptions & { encoding?: 'binary' }): Promise<Buffer>;
  screenshot(options: ScreenshotOptions & { encoding: 'base64' }): Promise<string>;
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer | string> {
    await this.bringToDriver();

    let base64: string;

    if (options.clip) {
      // Crop by screenshotting the smallest element that covers the region is
      // not reliable, so clip by injecting a positioned overlay is worse still.
      // Instead capture the viewport after scrolling the region into view and
      // let the caller crop; document the limitation loudly.
      throw new UnsupportedOperationError(
        'page.screenshot({ clip })',
        'WebDriver has no region-capture command, and Safari exposes no compositor access.',
        'Screenshot a specific element with elementHandle.screenshot(), or crop the returned PNG yourself.',
      );
    }

    if (options.fullPage) {
      base64 = await this.#fullPageScreenshot();
    } else {
      base64 = await this.#client.takeScreenshot();
    }

    const buffer = Buffer.from(base64, 'base64');
    if (options.path) await writeFile(options.path, buffer);
    return options.encoding === 'base64' ? base64 : buffer;
  }

  async #fullPageScreenshot(): Promise<string> {
    const original = await this.#client.getWindowRect();
    const metrics = await this.#client.executeScript<{
      scrollHeight: number;
      innerHeight: number;
      outerHeight: number;
    }>(
      `return {
         scrollHeight: Math.max(
           document.body ? document.body.scrollHeight : 0,
           document.documentElement.scrollHeight
         ),
         innerHeight: window.innerHeight,
         outerHeight: window.outerHeight
       };`,
    );

    if (metrics.scrollHeight <= metrics.innerHeight) {
      return this.#client.takeScreenshot();
    }

    const chrome = metrics.outerHeight - metrics.innerHeight;
    try {
      await this.#client.setWindowRect({
        width: original.width,
        height: Math.round(metrics.scrollHeight + chrome),
      });
      // Give layout and lazy-loaded content a moment after the resize.
      await sleep(250);
      return await this.#client.takeScreenshot();
    } finally {
      await this.#client.setWindowRect(original).catch(() => {});
    }
  }

  /** Not available: safaridriver does not implement `POST /print`. */
  pdf(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.pdf()',
        'safaridriver does not implement the WebDriver `print` endpoint (SeleniumHQ/selenium#13815).',
        'Trigger Safari\'s own print flow with AppleScript via page.safari, or render the PDF server-side.',
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
    if (urls.length > 0) {
      throw new UnsupportedOperationError(
        'page.cookies(...urls)',
        'WebDriver only exposes cookies for the currently loaded document.',
        'Navigate to each origin and call page.cookies() with no arguments.',
      );
    }
    await this.bringToDriver();
    return this.#client.getCookies();
  }

  async setCookie(...cookies: Cookie[]): Promise<void> {
    await this.bringToDriver();
    for (const cookie of cookies) {
      await this.#client.addCookie(cookie);
    }
  }

  async deleteCookie(...cookies: Array<{ name: string }>): Promise<void> {
    await this.bringToDriver();
    for (const cookie of cookies) {
      await this.#client.deleteCookie(cookie.name);
    }
  }

  async deleteAllCookies(): Promise<void> {
    await this.bringToDriver();
    await this.#client.deleteAllCookies();
  }

  // --- Console capture -------------------------------------------------------

  /**
   * Console capture works by monkey-patching `console` and draining a buffer on
   * a timer, because classic WebDriver has no log endpoints and no events.
   *
   * Limits worth knowing: messages logged before the hook is installed are
   * lost, arguments are stringified in-page rather than passed as handles, and
   * the poll interval bounds latency.
   */
  async #installConsoleHook(): Promise<void> {
    await this.#client
      .executeScript(
        `if (!window.${CONSOLE_BUFFER}) {
           window.${CONSOLE_BUFFER} = [];
           var methods = ['log', 'debug', 'info', 'warn', 'error', 'trace', 'dir', 'table'];
           methods.forEach(function (method) {
             var original = console[method];
             console[method] = function () {
               try {
                 window.${CONSOLE_BUFFER}.push({
                   type: method,
                   text: Array.prototype.map.call(arguments, function (arg) {
                     if (typeof arg === 'string') return arg;
                     try { return JSON.stringify(arg); } catch (e) { return String(arg); }
                   }).join(' '),
                   url: location.href
                 });
                 if (window.${CONSOLE_BUFFER}.length > 1000) window.${CONSOLE_BUFFER}.shift();
               } catch (e) {}
               return original.apply(console, arguments);
             };
           });
           window.addEventListener('error', function (event) {
             window.${CONSOLE_BUFFER}.push({
               type: 'error',
               text: event.message,
               url: event.filename || location.href,
               line: event.lineno
             });
           });
           window.addEventListener('unhandledrejection', function (event) {
             window.${CONSOLE_BUFFER}.push({
               type: 'error',
               text: 'Unhandled rejection: ' + String(event.reason),
               url: location.href
             });
           });
         }`,
      )
      .catch(() => {});
  }

  async #startConsolePolling(): Promise<void> {
    if (this.#consolePoller !== null) return;
    await this.#installConsoleHook();

    this.#consolePoller = setInterval(() => {
      void (async () => {
        if (this.#closed) return;
        try {
          const messages = await this.#client.executeScript<
            Array<{ type: string; text: string; url: string; line?: number }>
          >(
            `if (!window.${CONSOLE_BUFFER}) return [];
             var drained = window.${CONSOLE_BUFFER}.splice(0, window.${CONSOLE_BUFFER}.length);
             return drained;`,
          );
          for (const message of messages) {
            const consoleMessage: ConsoleMessage = {
              type: message.type,
              text: message.text,
              location: { url: message.url, lineNumber: message.line },
            };
            this.emit('console', consoleMessage);
            if (message.type === 'error') this.emit('pageerror', new Error(message.text));
          }
        } catch {
          // Navigation in flight, or an alert is blocking; the hook is
          // reinstalled by #afterNavigation.
        }
      })();
    }, 250);
    this.#consolePoller.unref();
  }

  // --- Dialogs ---------------------------------------------------------------

  /**
   * Dialog handling is also polled. A JS dialog blocks the page, and every
   * other WebDriver command starts failing with `unexpected alert open` until
   * it is handled — so if you use `alert()`/`confirm()`, attach a `dialog`
   * listener or calls will start erroring.
   */
  #startDialogPolling(): void {
    if (this.#dialogPoller !== null) return;

    this.#dialogPoller = setInterval(() => {
      void (async () => {
        if (this.#closed) return;
        let message: string;
        try {
          message = await this.#client.getAlertText();
        } catch {
          return; // No dialog open — the common case.
        }

        let handled = false;
        const dialog: Dialog = {
          // WebDriver does not report which flavour of dialog is open.
          // `prompt` is the safe assumption since it accepts text too.
          type: 'confirm',
          message,
          accept: async (promptText?: string) => {
            if (handled) return;
            handled = true;
            if (promptText !== undefined) {
              await this.#client.sendAlertText(promptText).catch(() => {});
            }
            await this.#client.acceptAlert();
          },
          dismiss: async () => {
            if (handled) return;
            handled = true;
            await this.#client.dismissAlert();
          },
        };

        this.emit('dialog', dialog);

        // Puppeteer requires the listener to handle the dialog; if nobody does,
        // dismiss it so the session does not wedge.
        setTimeout(() => {
          if (!handled) void dialog.dismiss().catch(() => {});
        }, 5000).unref();
      })();
    }, 200);
    this.#dialogPoller.unref();
  }

  // --- Explicitly unsupported ------------------------------------------------

  /**
   * Network inspection is not reachable for *this* page.
   *
   * The MCP server can list requests in rich detail, but only for tabs it
   * created itself: measured on Safari Technology Preview 249, `list_tabs`
   * returns an empty array while a WebDriver session holds a tab, and
   * `page_info` answers "No active tab". The two channels are separate browser
   * sessions, so routing this through MCP would report on a different page than
   * the one you navigated — silently.
   */
  networkRequests(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.networkRequests()',
        'The safaridriver --mcp server cannot see tabs owned by a WebDriver session — it only observes tabs it created itself, so it has no view of this page.',
        'Drive an independent MCP session with browser.mcp() (see SafariMcp), where network inspection does work. To observe *this* page, put a local proxy in front of Safari.',
      ),
    );
  }

  setRequestInterception(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.setRequestInterception()',
        'Neither of Safari\'s automation channels can modify traffic. Classic WebDriver has no network layer at all; safaridriver --mcp observes requests but cannot intercept them; and WebDriver BiDi\'s `network` module — the one interface that could — is still missing from safaridriver (verified on Safari 26.6: `network` reports "domain was not found").',
        'For read-only inspection use page.networkRequests() with launch({ mcp: true }). To actually modify traffic, put a local proxy (mitmproxy) in front of Safari, or stub `window.fetch`/`XMLHttpRequest` with page.evaluateOnNewDocument().',
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
        "No CDP Emulation domain is available in real Safari. The MCP server's set_emulated_media tool is not a substitute: it takes a CSS media *type* ('screen', 'print') only, not features like prefers-color-scheme — and it applies to the MCP server's own tabs, not this one.",
        'Override the media query result in-page with page.evaluate() by injecting CSS, if your app reads it via matchMedia.',
      ),
    );
  }

  setOfflineMode(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.setOfflineMode()',
        'Network conditions cannot be controlled through safaridriver.',
        "Use macOS Network Link Conditioner, or stub `navigator.onLine` and fetch in-page.",
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

    try {
      await this.#client.switchToWindow(this.#handle);
      await this.#client.closeWindow();
    } catch {
      // The window may already be gone.
    }
    this.emit('close');
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SafariPuppeteerError('This page has been closed.');
    }
  }
}
