/**
 * The classic W3C WebDriver backend — the default, and the only one that works
 * on a stable Safari.
 *
 * This is where every safaridriver-specific quirk now lives: window-handle
 * multiplexing, the frame path that has to be replayed after a window switch,
 * the emulated full-page screenshot, and the monkey-patched console buffer.
 */
import type { Dialog, ScreenshotOptions, Viewport } from '../api/Page.ts';
import { ElementHandle, elementHandleFromId, createHandle, JSHandle } from '../api/JSHandle.ts';
import { ExecutionContext } from '../api/ExecutionContext.ts';
import { UnsupportedOperationError, WebDriverError } from '../common/errors.ts';
import { sleep } from '../common/util.ts';
import type { Rect, WebDriverClient, WebDriverCookie } from '../webdriver/client.ts';
import type {
  BackendFeature,
  BackendName,
  ClickOptions,
  ConsoleRecord,
  PageBackend,
} from './types.ts';

const CONSOLE_BUFFER = '__safariPuppeteerConsole__';

/** W3C's element-reference key, used when switching into a frame. */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const SUPPORTED: ReadonlySet<BackendFeature> = new Set<BackendFeature>([
  'elementHandles',
  'cookies',
  'frames',
  'xpath',
  'dialogs',
  'windowRect',
  'trustedInput',
]);

export class WebDriverBackend implements PageBackend {
  readonly name: BackendName = 'webdriver';

  #client: WebDriverClient;
  #handle: string;
  #context: ExecutionContext;
  /** Frames entered by the caller, replayed after every window switch. */
  #framePath: Array<number | string> = [];

  constructor(client: WebDriverClient, handle: string) {
    this.#client = client;
    this.#handle = handle;
    this.#context = new ExecutionContext(client);
  }

  supports(feature: BackendFeature): boolean {
    return SUPPORTED.has(feature);
  }

  /** Escape hatch for `page.client`. */
  get client(): WebDriverClient {
    return this.#client;
  }

  get context(): ExecutionContext {
    return this.#context;
  }

  get windowHandle(): string {
    return this.#handle;
  }

  async activate(): Promise<void> {
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
        await this.#client.switchToFrame({ [ELEMENT_KEY]: step });
      }
    }
  }

  /** A navigation drops us back to the top-level browsing context. */
  onNavigated(): void {
    this.#framePath = [];
  }

  // --- Navigation ------------------------------------------------------------

  async navigate(url: string, timeout: number): Promise<void> {
    await this.#client.setTimeouts({ pageLoad: timeout }).catch(() => {});
    await this.#client.navigateTo(url);
  }

  async reload(): Promise<void> {
    await this.#client.refresh();
  }

  async back(): Promise<void> {
    await this.#client.back();
  }

  async forward(): Promise<void> {
    await this.#client.forward();
  }

  currentUrl(): Promise<string> {
    return this.#client.getCurrentUrl();
  }

  currentTitle(): Promise<string> {
    return this.#client.getTitle();
  }

  // --- Evaluation ------------------------------------------------------------

  evaluate<T>(fn: Function | string, args: unknown[]): Promise<T> {
    return this.#context.evaluate<T>(fn, ...args);
  }

  async evaluateQuietly(source: string): Promise<void> {
    await this.#client.executeScript(source).catch(() => {});
  }

  async evaluateHandle(fn: Function | string, args: unknown[]): Promise<JSHandle> {
    const descriptor = await this.#context.evaluateHandle(fn, ...args);
    return createHandle(this.#context, descriptor);
  }

  // --- Selectors -------------------------------------------------------------

  async find(selector: string): Promise<ElementHandle | null> {
    try {
      const id = await this.#client.findElement('css selector', selector);
      return elementHandleFromId(this.#context, id);
    } catch (error) {
      if (error instanceof WebDriverError && error.code === 'no such element') return null;
      throw error;
    }
  }

  async findAll(selector: string): Promise<ElementHandle[]> {
    const ids = await this.#client.findElements('css selector', selector);
    return ids.map((id) => elementHandleFromId(this.#context, id));
  }

  async findAllByXPath(expression: string): Promise<ElementHandle[]> {
    const ids = await this.#client.findElements('xpath', expression);
    return ids.map((id) => elementHandleFromId(this.#context, id));
  }

  // --- Input -----------------------------------------------------------------
  //
  // Composed from element handles, which dispatch through the W3C Actions API
  // and so arrive as trusted events.

  async click(selector: string, options: ClickOptions): Promise<void> {
    await (await this.#require(selector)).click(options);
  }

  async type(selector: string, text: string, options: { delay?: number }): Promise<void> {
    await (await this.#require(selector)).type(text, options);
  }

  async hover(selector: string): Promise<void> {
    await (await this.#require(selector)).hover();
  }

  async focus(selector: string): Promise<void> {
    await (await this.#require(selector)).focus();
  }

  async tap(selector: string): Promise<void> {
    await (await this.#require(selector)).tap();
  }

  async select(selector: string, values: string[]): Promise<string[]> {
    return (await this.#require(selector)).select(...values);
  }

  async #require(selector: string): Promise<ElementHandle> {
    const element = await this.find(selector);
    if (element === null) {
      throw new WebDriverError('no such element', `No element matches "${selector}".`);
    }
    return element;
  }

  // --- Capture ---------------------------------------------------------------

  async screenshot(options: ScreenshotOptions): Promise<string> {
    return options.fullPage ? this.#fullPageScreenshot() : this.#client.takeScreenshot();
  }

  /**
   * safaridriver clips `/screenshot` to the viewport on Safari before 27 /
   * STP 247, so grow the window to the document height, capture, and restore.
   * The OS caps window height, so very tall pages are still truncated — the
   * returned image is whatever fit.
   */
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

  /**
   * WebDriver sizes the outer window, so measure the chrome and compensate.
   * One correction pass follows, because chrome height changes when e.g. the
   * tab bar wraps.
   */
  async setViewport(viewport: Viewport): Promise<void> {
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

    ({ inner, outer } = await measure());
    if (inner[0] !== viewport.width || inner[1] !== viewport.height) {
      chromeWidth = outer[0] - inner[0];
      chromeHeight = outer[1] - inner[1];
      await this.#client.setWindowRect({
        width: Math.round(viewport.width + chromeWidth),
        height: Math.round(viewport.height + chromeHeight),
      });
    }
  }

  windowRect(): Promise<Rect> {
    return this.#client.getWindowRect();
  }

  setWindowRect(rect: Partial<Rect>): Promise<Rect> {
    return this.#client.setWindowRect(rect);
  }

  async maximize(): Promise<void> {
    await this.#client.maximizeWindow();
  }

  // --- Cookies ---------------------------------------------------------------

  cookies(): Promise<WebDriverCookie[]> {
    return this.#client.getCookies();
  }

  async addCookie(cookie: WebDriverCookie): Promise<void> {
    await this.#client.addCookie(cookie);
  }

  async deleteCookie(name: string): Promise<void> {
    await this.#client.deleteCookie(name);
  }

  async deleteAllCookies(): Promise<void> {
    await this.#client.deleteAllCookies();
  }

  // --- Frames ----------------------------------------------------------------

  async enterFrame(target: number | ElementHandle): Promise<void> {
    if (typeof target === 'number') {
      await this.#client.switchToFrame(target);
      this.#framePath.push(target);
    } else {
      await this.#client.switchToFrame({ [ELEMENT_KEY]: target.elementId });
      this.#framePath.push(target.elementId);
    }
  }

  async exitFrame(): Promise<void> {
    await this.#client.switchToParentFrame();
    this.#framePath.pop();
  }

  async exitAllFrames(): Promise<void> {
    await this.#client.switchToWindow(this.#handle);
    await this.#client.switchToFrame(null);
    this.#framePath = [];
  }

  // --- Observation -----------------------------------------------------------

  /**
   * Classic WebDriver has no log endpoint, so `console` is monkey-patched and a
   * buffer drained on a timer. Messages logged before this runs are lost.
   */
  async prepareConsole(): Promise<void> {
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

  drainConsole(): Promise<ConsoleRecord[]> {
    return this.#client.executeScript<ConsoleRecord[]>(
      `if (!window.${CONSOLE_BUFFER}) return [];
       var drained = window.${CONSOLE_BUFFER}.splice(0, window.${CONSOLE_BUFFER}.length);
       return drained;`,
    );
  }

  async pendingDialog(): Promise<Dialog | null> {
    let message: string;
    try {
      message = await this.#client.getAlertText();
    } catch {
      return null; // No dialog open — the common case.
    }

    let handled = false;
    return {
      // WebDriver does not report which flavour of dialog is open. `confirm`
      // is the safe assumption since accept/dismiss both apply.
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
  }

  networkRequests(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.networkRequests()',
        'The WebDriver backend has no network layer at all — classic W3C WebDriver exposes no request data.',
        "Launch with backend: 'mcp' on Safari Technology Preview 247+, which can observe requests read-only. To modify traffic, use a local proxy.",
      ),
    );
  }

  setEmulatedMediaType(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'page.emulateMediaType()',
        'safaridriver exposes no media-emulation endpoint.',
        "Launch with backend: 'mcp' on Safari Technology Preview 247+, or inject a print stylesheet with page.evaluate().",
      ),
    );
  }

  async close(): Promise<void> {
    try {
      await this.#client.switchToWindow(this.#handle);
      await this.#client.closeWindow();
    } catch {
      // The window may already be gone.
    }
  }
}
