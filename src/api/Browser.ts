import { EventEmitter } from 'node:events';

import { SafariApp } from '../applescript/safari.ts';
import { SafariPuppeteerError } from '../common/errors.ts';
import type { BackendName, BrowserSession } from '../backend/types.ts';
import { WebDriverSession } from '../backend/sessions.ts';
import type { WebDriverClient } from '../webdriver/client.ts';
import { Page, type Viewport } from './Page.ts';

/**
 * A Safari instance under automation.
 *
 * One Browser == one safaridriver process == one WebDriver session. Pages are
 * tabs within that session's window, multiplexed by switching the driver's
 * active window handle (see {@link Page.bringToDriver}).
 */
export class Browser extends EventEmitter {
  #session: BrowserSession;
  #safari: SafariApp;
  #pages = new Map<string, Page>();
  #defaultViewport: Viewport | null;
  #capabilities: Record<string, unknown>;
  #closed = false;


  constructor(options: {
    session: BrowserSession;
    safari: SafariApp;
    defaultViewport?: Viewport | null;
    capabilities?: Record<string, unknown>;
  }) {
    super();
    this.#session = options.session;
    this.#safari = options.safari;
    this.#defaultViewport = options.defaultViewport ?? null;
    this.#capabilities = options.capabilities ?? {};
  }


  /** Capabilities safaridriver reported when the session was created. */
  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  /** Which backend drives this browser's pages. */
  get backendName(): BackendName {
    return this.#session.name;
  }

  /**
   * Low-level escape hatch: the raw WebDriver client.
   *
   * Only meaningful on the WebDriver backend; the MCP backend speaks no
   * WebDriver, so this throws rather than returning something unusable.
   */
  get client(): WebDriverClient {
    const session = this.#session;
    if (!(session instanceof WebDriverSession)) {
      throw new SafariPuppeteerError(
        `The "${session.name}" backend does not speak WebDriver, so browser.client is unavailable.\n` +
          "Launch with backend: 'webdriver' (the default) if you need it.",
      );
    }
    return session.client;
  }

  /** Low-level escape hatch: AppleScript control of the Safari app. */
  get safari(): SafariApp {
    return this.#safari;
  }

  get connected(): boolean {
    return !this.#closed;
  }

  /** `Browser.version()`, e.g. `Safari/18.6`. */
  async version(): Promise<string> {
    const name = (this.#capabilities['browserName'] as string) ?? 'Safari';
    const version = (this.#capabilities['browserVersion'] as string) ?? 'unknown';
    return `${name}/${version}`;
  }

  /** The page's user agent string, read from the page itself. */
  async userAgent(): Promise<string> {
    const [page] = await this.pages();
    if (!page) throw new SafariPuppeteerError('No open pages to read the user agent from.');
    return page.evaluate<string>(() => navigator.userAgent);
  }

  /**
   * Adopt the session's current window as the first Page.
   * Called once during launch/connect.
   */
  async initialize(): Promise<Page> {
    const handle = await this.#session.currentHandle();
    const page = this.#adopt(handle);
    if (this.#defaultViewport) {
      await page.setViewport(this.#defaultViewport).catch(() => {
        // Window sizing can fail if the window is full-screen; not fatal.
      });
    }
    return page;
  }

  /** Open a new tab and return it as a Page. */
  async newPage(): Promise<Page> {
    this.#assertOpen();
    const handle = await this.#session.newTab();
    const page = this.#adopt(handle);
    if (this.#defaultViewport) {
      await page.setViewport(this.#defaultViewport).catch(() => {});
    }
    this.emit('targetcreated', page);
    return page;
  }

  /**
   * All pages in this session, refreshed against the driver's live handles so
   * that tabs opened by the page itself (`window.open`, `target=_blank`) show
   * up and closed ones are dropped.
   */
  async pages(): Promise<Page[]> {
    this.#assertOpen();
    const handles = await this.#session.listHandles();
    const live = new Set(handles);

    for (const [handle, page] of this.#pages) {
      if (!live.has(handle)) {
        this.#pages.delete(handle);
        this.emit('targetdestroyed', page);
      }
    }
    for (const handle of handles) {
      if (!this.#pages.has(handle)) {
        this.emit('targetcreated', this.#adopt(handle));
      }
    }

    return handles.map((handle) => this.#pages.get(handle)!).filter(Boolean);
  }

  /** Wait for a page matching `predicate`, e.g. a popup opened by a click. */
  async waitForTarget(
    predicate: (page: Page) => boolean | Promise<boolean>,
    options: { timeout?: number } = {},
  ): Promise<Page> {
    const { poll } = await import('../common/util.ts');
    return poll(
      async () => {
        for (const page of await this.pages()) {
          if (await predicate(page)) return page;
        }
        return null;
      },
      { timeout: options.timeout ?? 30_000, message: 'Waiting for a matching target' },
    );
  }

  #adopt(handle: string): Page {
    const existing = this.#pages.get(handle);
    if (existing) return existing;
    const page = new Page(this.#session.createBackend(handle), handle, this.#safari);
    this.#pages.set(handle, page);
    return page;
  }

  /**
   * End the session and stop safaridriver.
   *
   * This closes the automation window. It does not quit the user's own Safari
   * windows — those are outside the session.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const page of this.#pages.values()) {
      // Mark pages closed so their pollers stop; the session teardown below
      // takes care of the actual windows.
      await page.close().catch(() => {});
    }
    this.#pages.clear();

    await this.#session.dispose();
    this.emit('disconnected');
  }

  /** Detach without ending the session, leaving Safari under automation. */
  async disconnect(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const page of this.#pages.values()) {
      page.removeAllListeners();
    }
    this.#pages.clear();
    this.emit('disconnected');
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SafariPuppeteerError('Browser is closed or disconnected.');
    }
  }
}
