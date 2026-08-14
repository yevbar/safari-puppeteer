import { EventEmitter } from 'node:events';

import { SafariApp } from '../applescript/safari.ts';
import { McpError, SafariPuppeteerError } from '../common/errors.ts';
import { SafariMcp } from '../mcp/SafariMcp.ts';
import type { WebDriverClient } from '../webdriver/client.ts';
import type { SafariDriverProcess } from '../webdriver/safaridriver.ts';
import { Page, type Viewport } from './Page.ts';

/**
 * A Safari instance under automation.
 *
 * One Browser == one safaridriver process == one WebDriver session. Pages are
 * tabs within that session's window, multiplexed by switching the driver's
 * active window handle (see {@link Page.bringToDriver}).
 */
export class Browser extends EventEmitter {
  #client: WebDriverClient;
  #process: SafariDriverProcess | null;
  #safari: SafariApp;
  #pages = new Map<string, Page>();
  #defaultViewport: Viewport | null;
  #capabilities: Record<string, unknown>;
  #closed = false;

  /** Set when the caller asked for the MCP channel. */
  #mcpBinary: string | null;
  #mcp: SafariMcp | null = null;
  /** In-flight start, so concurrent `mcp()` calls share one server. */
  #mcpStarting: Promise<SafariMcp> | null = null;

  constructor(options: {
    client: WebDriverClient;
    process: SafariDriverProcess | null;
    safari: SafariApp;
    defaultViewport?: Viewport | null;
    capabilities?: Record<string, unknown>;
    /** safaridriver to run with `--mcp`. Null disables the MCP channel. */
    mcpBinary?: string | null;
  }) {
    super();
    this.#client = options.client;
    this.#process = options.process;
    this.#safari = options.safari;
    this.#defaultViewport = options.defaultViewport ?? null;
    this.#capabilities = options.capabilities ?? {};
    this.#mcpBinary = options.mcpBinary ?? null;
  }

  /**
   * The `safaridriver --mcp` channel, started on first use.
   *
   * Deliberately lazy: starting it spawns a second driver process, and most
   * scripts never need it.
   */
  async mcp(): Promise<SafariMcp> {
    if (this.#mcpBinary === null) {
      throw new McpError(
        'The MCP channel is not enabled for this browser.\n' +
          'Launch with mcp: true to enable it.',
      );
    }
    if (this.#mcp !== null) return this.#mcp;
    if (this.#mcpStarting !== null) return this.#mcpStarting;

    this.#mcpStarting = SafariMcp.start({ binary: this.#mcpBinary })
      .then((mcp) => {
        this.#mcp = mcp;
        return mcp;
      })
      .finally(() => {
        this.#mcpStarting = null;
      });
    return this.#mcpStarting;
  }

  /** Whether the MCP channel was enabled at launch. */
  get mcpEnabled(): boolean {
    return this.#mcpBinary !== null;
  }

  /** Capabilities safaridriver reported when the session was created. */
  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  /** Low-level escape hatch: the raw WebDriver client. */
  get client(): WebDriverClient {
    return this.#client;
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
    const handle = await this.#client.getWindowHandle();
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
    const { handle } = await this.#client.newWindow('tab');
    const page = this.#adopt(handle);
    await this.#client.switchToWindow(handle);
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
    const handles = await this.#client.getWindowHandles();
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
    const page = new Page(
      this.#client,
      handle,
      this.#safari,
      this.#mcpBinary === null ? null : () => this.mcp(),
    );
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

    await this.#mcp?.close().catch(() => {});
    this.#mcp = null;
    await this.#client.deleteSession().catch(() => {});
    await this.#process?.kill();
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
