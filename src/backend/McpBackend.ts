/**
 * The `safaridriver --mcp` backend — optional, and Safari Technology Preview
 * 247+ only.
 *
 * Its reason to exist is network inspection. Because the MCP server can only
 * observe tabs it created itself, that capability is unreachable while a
 * WebDriver session owns the page; making MCP the *only* channel is what puts
 * `page.networkRequests()` within reach of the page you are actually driving.
 *
 * The trade is real and is declared through `supports()`: no element handles,
 * no cookies, no frames, no XPath, no window geometry, and no low-level
 * Actions API. Input goes through the server's `page_interactions` tool, which
 * settles ~400 ms between steps, so it is markedly slower than WebDriver.
 */
import type { Dialog, ScreenshotOptions, Viewport } from '../api/Page.ts';
import type { ElementHandle, JSHandle } from '../api/JSHandle.ts';
import { SafariPuppeteerError, UnsupportedOperationError } from '../common/errors.ts';
import type { SafariMcp } from '../mcp/SafariMcp.ts';
import type { Rect, WebDriverCookie } from '../webdriver/client.ts';
import type {
  BackendFeature,
  BackendName,
  ClickOptions,
  ConsoleRecord,
  PageBackend,
} from './types.ts';

const SUPPORTED: ReadonlySet<BackendFeature> = new Set<BackendFeature>([
  'dialogs',
  'networkInspection',
  'mediaType',
]);

interface Point {
  x: number;
  y: number;
}

export class McpBackend implements PageBackend {
  readonly name: BackendName = 'mcp';

  #mcp: SafariMcp;
  #handle: string;
  /**
   * Network recording only covers traffic after the first
   * `list_network_requests` call, so it is armed before the first navigation
   * rather than lazily when someone asks for the results — by then the
   * requests they wanted are already gone.
   */
  #captureArmed = false;

  constructor(mcp: SafariMcp, handle: string) {
    this.#mcp = mcp;
    this.#handle = handle;
  }

  supports(feature: BackendFeature): boolean {
    return SUPPORTED.has(feature);
  }

  /** Escape hatch: the underlying MCP client. */
  get mcp(): SafariMcp {
    return this.#mcp;
  }

  get tabHandle(): string {
    return this.#handle;
  }

  async activate(): Promise<void> {
    await this.#mcp.switchTab(this.#handle);
  }

  onNavigated(): void {
    // No per-document state to drop: this backend has no frame path.
  }

  // --- Navigation ------------------------------------------------------------

  async navigate(url: string): Promise<void> {
    await this.#armCapture();
    await this.#mcp.navigate(url, this.#handle);
  }

  async #armCapture(): Promise<void> {
    if (this.#captureArmed) return;
    this.#captureArmed = true;
    await this.#mcp.startNetworkCapture(this.#handle).catch(() => {
      // Not fatal: only network inspection is affected, and it will report an
      // empty list rather than wrong data.
    });
  }

  async reload(): Promise<void> {
    await this.evaluate(() => {
      location.reload();
    }, []);
  }

  async back(): Promise<void> {
    await this.evaluate(() => {
      history.back();
    }, []);
  }

  async forward(): Promise<void> {
    await this.evaluate(() => {
      history.forward();
    }, []);
  }

  async currentUrl(): Promise<string> {
    const info = (await this.#mcp.pageInfo()) as { url?: string };
    return info?.url ?? '';
  }

  async currentTitle(): Promise<string> {
    const info = (await this.#mcp.pageInfo()) as { title?: string };
    return info?.title ?? '';
  }

  // --- Evaluation ------------------------------------------------------------

  /**
   * The tool takes a function *body* and no argument list, so arguments are
   * serialized into the body rather than passed alongside it.
   */
  async evaluate<T>(fn: Function | string, args: unknown[]): Promise<T> {
    const body =
      typeof fn === 'string'
        ? `return (${fn});`
        : `return (${fn.toString()}).apply(null, ${JSON.stringify(args ?? [])});`;
    return (await this.#mcp.evaluateBody(body)) as T;
  }

  async evaluateQuietly(source: string): Promise<void> {
    await this.#mcp.evaluateBody(source).catch(() => {});
  }

  evaluateHandle(): Promise<JSHandle> {
    return Promise.reject(this.#unsupported('page.evaluateHandle()', 'element references'));
  }

  // --- Selectors -------------------------------------------------------------

  find(): Promise<ElementHandle | null> {
    return Promise.reject(this.#unsupported('page.$()', 'element references'));
  }

  findAll(): Promise<ElementHandle[]> {
    return Promise.reject(this.#unsupported('page.$$()', 'element references'));
  }

  findAllByXPath(): Promise<ElementHandle[]> {
    return Promise.reject(this.#unsupported('page.$x()', 'XPath queries'));
  }

  // --- Input -----------------------------------------------------------------
  //
  // Driven by viewport point rather than node UID: UIDs come from
  // get_page_content, and resolving a CSS selector to one would mean parsing
  // that output. A rect measured in-page is both simpler and exact.

  async click(selector: string, options: ClickOptions): Promise<void> {
    const point = await this.#centerOf(selector);
    const clicks = Math.max(1, options.clickCount ?? 1);
    await this.#mcp.interact(
      Array.from({ length: clicks }, () => ({
        type: 'click',
        point,
        purpose: `Click ${selector}`,
      })),
    );
  }

  /**
   * Typed one key at a time, which is slow but produces real key events.
   *
   * The server's `type` interaction cannot be used: it requires a node
   * identifier from `get_page_content`, and the `$uid(N)` macro that would map
   * a selector onto one is not implemented in Technology Preview 249
   * (`Can't find variable: $`). Point-addressed `type` fails with
   * "Missing nodeIdentifier" — and does so *successfully*, which is why
   * {@link SafariMcp.interact} now checks the step count.
   *
   * `keyPress` accepts a point-focused target, so it is the only route that
   * dispatches genuine `keydown`/`keypress`. Setting `value` in-page would be
   * instant but silent — no key events at all — which breaks anything with a
   * keystroke handler.
   *
   * Budget roughly 0.4s per character: the server settles between steps. For
   * long strings, `page.evaluate()` is far faster if you do not need the
   * events.
   */
  async type(selector: string, text: string): Promise<void> {
    const point = await this.#centerOf(selector);
    await this.#mcp.interact([
      { type: 'click', point, purpose: `Focus ${selector}` },
      ...Array.from(text, (character) => ({
        type: 'keyPress',
        value: character,
        purpose: `Type ${JSON.stringify(character)}`,
      })),
    ]);
  }

  async hover(selector: string): Promise<void> {
    const point = await this.#centerOf(selector);
    await this.#mcp.interact([{ type: 'hover', point, purpose: `Hover ${selector}` }]);
  }

  async tap(selector: string): Promise<void> {
    await this.click(selector, {});
  }

  /** Focus is set in-page: there is no interaction type for it. */
  async focus(selector: string): Promise<void> {
    const ok = await this.evaluate<boolean>((sel: string) => {
      const node = document.querySelector(sel) as HTMLElement | null;
      if (node === null) return false;
      node.focus();
      return true;
    }, [selector]);
    if (!ok) throw new SafariPuppeteerError(`No element matches "${selector}".`);
  }

  /**
   * Applied in-page, because `selectMenuItem` addresses native menus by label
   * rather than a `<select>` by value.
   *
   * The single-select branch matters: setting `selected = false` on the only
   * selected option of a single `<select>` makes the HTML "ask for a reset"
   * algorithm re-select the first option.
   */
  async select(selector: string, values: string[]): Promise<string[]> {
    const selected = await this.evaluate<string[] | null>(
      (sel: string, wanted: string[]) => {
        const element = document.querySelector(sel) as HTMLSelectElement | null;
        if (element === null) return null;

        if (element.multiple) {
          for (const option of Array.from(element.options)) {
            option.selected = wanted.includes(option.value);
          }
        } else {
          const match = Array.from(element.options).find((option) =>
            wanted.includes(option.value),
          );
          if (match) element.value = match.value;
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(element.selectedOptions).map((option) => option.value);
      },
      [selector, values],
    );

    if (selected === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    return selected;
  }

  /** Viewport-centre point of a selector, scrolled into view first. */
  async #centerOf(selector: string): Promise<Point> {
    const point = await this.evaluate<Point | null>((sel: string) => {
      const node = document.querySelector(sel);
      if (node === null) return null;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    }, [selector]);

    if (point === null) throw new SafariPuppeteerError(`No element matches "${selector}".`);
    return point;
  }

  // --- Capture ---------------------------------------------------------------

  /** `fullPage` is native here, not emulated by resizing the window. */
  screenshot(options: ScreenshotOptions): Promise<string> {
    return this.#mcp.screenshot({ fullPage: options.fullPage ?? false });
  }

  async setViewport(viewport: Viewport): Promise<void> {
    await this.#mcp.setViewportSize(viewport.width, viewport.height);
  }

  windowRect(): Promise<Rect> {
    return Promise.reject(this.#unsupported('page.windowRect()', 'window geometry'));
  }

  setWindowRect(): Promise<Rect> {
    return Promise.reject(this.#unsupported('page.setWindowRect()', 'window geometry'));
  }

  maximize(): Promise<void> {
    return Promise.reject(this.#unsupported('page.maximize()', 'window geometry'));
  }

  // --- Cookies ---------------------------------------------------------------

  cookies(): Promise<WebDriverCookie[]> {
    return Promise.reject(this.#unsupported('page.cookies()', 'cookies'));
  }

  addCookie(): Promise<void> {
    return Promise.reject(this.#unsupported('page.setCookie()', 'cookies'));
  }

  deleteCookie(): Promise<void> {
    return Promise.reject(this.#unsupported('page.deleteCookie()', 'cookies'));
  }

  deleteAllCookies(): Promise<void> {
    return Promise.reject(this.#unsupported('page.deleteAllCookies()', 'cookies'));
  }

  // --- Frames ----------------------------------------------------------------

  enterFrame(): Promise<void> {
    return Promise.reject(this.#unsupported('page.enterFrame()', 'frame switching'));
  }

  exitFrame(): Promise<void> {
    return Promise.reject(this.#unsupported('page.exitFrame()', 'frame switching'));
  }

  exitAllFrames(): Promise<void> {
    return Promise.reject(this.#unsupported('page.exitAllFrames()', 'frame switching'));
  }

  // --- Observation -----------------------------------------------------------

  /** Nothing to install: the server buffers console output itself. */
  async prepareConsole(): Promise<void> {}

  /**
   * Unlike the WebDriver backend's injected hook, this catches messages logged
   * before anyone was listening — the server has been buffering since the tab
   * opened.
   */
  async drainConsole(): Promise<ConsoleRecord[]> {
    const raw = await this.#mcp.consoleMessages({ clear: true, tabHandle: this.#handle });
    const entries = Array.isArray(raw)
      ? raw
      : ((raw as { messages?: unknown[] })?.messages ?? []);

    return entries.map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        type: String(record['level'] ?? record['type'] ?? 'log'),
        text: String(record['text'] ?? record['message'] ?? ''),
        url: String(record['url'] ?? record['source'] ?? ''),
        line: typeof record['line'] === 'number' ? record['line'] : undefined,
      };
    });
  }

  async pendingDialog(): Promise<Dialog | null> {
    const raw = await this.#mcp.dialog('list').catch(() => null);
    const entries = Array.isArray(raw)
      ? raw
      : ((raw as { dialogs?: unknown[] })?.dialogs ?? []);
    const first = entries[0] as Record<string, unknown> | undefined;
    if (first === undefined) return null;

    const kind = String(first['type'] ?? 'confirm');
    return {
      type: (['alert', 'confirm', 'prompt', 'beforeunload'].includes(kind)
        ? kind
        : 'confirm') as Dialog['type'],
      message: String(first['message'] ?? first['text'] ?? ''),
      accept: async (promptText?: string) => {
        await this.#mcp.dialog('respond', promptText);
      },
      dismiss: async () => {
        await this.#mcp.dialog('dismiss');
      },
    };
  }

  /** The capability this whole backend exists for. */
  async networkRequests(options: { clear?: boolean; filter?: string }): Promise<unknown> {
    await this.#armCapture();
    return this.#mcp.listNetworkRequests({ ...options, tabHandle: this.#handle });
  }

  async setEmulatedMediaType(media: string): Promise<void> {
    await this.#mcp.setEmulatedMediaType(media);
  }

  // --- Lifecycle -------------------------------------------------------------

  async close(): Promise<void> {
    await this.#mcp.closeTab(this.#handle).catch(() => {
      // The tab may already be gone.
    });
  }

  #unsupported(api: string, what: string): UnsupportedOperationError {
    return new UnsupportedOperationError(
      api,
      `The MCP backend has no ${what}: safaridriver --mcp exposes tools, not a WebDriver session.`,
      "Launch with backend: 'webdriver' (the default) if you need this. Note that network inspection is then unavailable, since the MCP server cannot observe WebDriver-owned tabs.",
    );
  }
}
