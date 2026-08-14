/**
 * The backend interface `Page` talks to.
 *
 * Everything protocol-specific lives behind this: WebDriver commands in
 * {@link WebDriverBackend}, MCP tool calls in {@link McpBackend}. Everything
 * generic — poll loops, `waitUntil` handling, init-script replay, the console
 * hook, the dialog wrapper — stays in `Page`, expressed in terms of these
 * primitives so both backends inherit it.
 *
 * The two backends are not equally capable, and pretending otherwise would be
 * the worst outcome. {@link PageBackend.supports} is how a backend declares
 * what it cannot do, so `Page` can throw an `UnsupportedOperationError` naming
 * the backend instead of failing obscurely deep in a protocol call.
 */
import type { Dialog, ScreenshotOptions, Viewport } from '../api/Page.ts';
import type { ElementHandle, JSHandle } from '../api/JSHandle.ts';
import type { Rect, WebDriverCookie } from '../webdriver/client.ts';

export type BackendName = 'webdriver' | 'mcp';

/**
 * Capabilities that differ between backends.
 *
 * Each is something a real Puppeteer script would reach for, so the set is
 * driven by what breaks rather than by protocol trivia.
 */
export type BackendFeature =
  /** `page.$`, `evaluateHandle`, and anything returning an ElementHandle. */
  | 'elementHandles'
  /** `page.cookies` and friends. */
  | 'cookies'
  /** `enterFrame` / `exitFrame`. */
  | 'frames'
  /** XPath queries (`page.$x`). */
  | 'xpath'
  /** JS dialog interception. */
  | 'dialogs'
  /** Read-only network request inspection. */
  | 'networkInspection'
  /** `set_emulated_media`-style CSS media type override. */
  | 'mediaType'
  /** OS-level window geometry (`windowRect`, `maximize`). */
  | 'windowRect'
  /** The low-level W3C Actions API, i.e. `page.keyboard` / `page.mouse`. */
  | 'lowLevelInput';

/**
 * Browser-level operations that differ between backends.
 *
 * `Browser` owns tab bookkeeping and lifecycle; this is the small set of calls
 * underneath that are protocol-specific.
 */
export interface BrowserSession {
  readonly name: BackendName;
  /** Handles of every open tab. */
  listHandles(): Promise<string[]>;
  /** Handle of the tab commands currently apply to. */
  currentHandle(): Promise<string>;
  /** Open a tab and return its handle. */
  newTab(): Promise<string>;
  /** Build the page backend for a handle. */
  createBackend(handle: string): PageBackend;
  /** Tear the session down. */
  dispose(): Promise<void>;
}

export interface ConsoleRecord {
  type: string;
  text: string;
  url: string;
  line?: number;
}

/** Options `Page` passes down for a click. */
export interface ClickOptions {
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  delay?: number;
}

export interface PageBackend {
  readonly name: BackendName;

  /** Whether this backend implements a given capability. */
  supports(feature: BackendFeature): boolean;

  /**
   * Make this page the one subsequent commands apply to.
   *
   * Both backends multiplex several pages over one connection, so this is
   * called before every operation.
   */
  activate(): Promise<void>;

  // --- Navigation ------------------------------------------------------------

  navigate(url: string, timeout: number): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  currentUrl(): Promise<string>;
  currentTitle(): Promise<string>;

  /**
   * Told after every completed navigation, so a backend can drop per-document
   * state — the WebDriver one uses this to forget the frame path.
   */
  onNavigated(): void;

  // --- Evaluation ------------------------------------------------------------

  /** Evaluate a function or expression with structured-clone-able arguments. */
  evaluate<T>(fn: Function | string, args: unknown[]): Promise<T>;

  /** Evaluate for its side effects only, swallowing failures (init scripts). */
  evaluateQuietly(source: string): Promise<void>;

  /** Evaluate and keep the result alive as a handle. */
  evaluateHandle(fn: Function | string, args: unknown[]): Promise<JSHandle>;

  // --- Selectors -------------------------------------------------------------

  find(selector: string): Promise<ElementHandle | null>;
  findAll(selector: string): Promise<ElementHandle[]>;
  findAllByXPath(expression: string): Promise<ElementHandle[]>;

  // --- Input -----------------------------------------------------------------

  /**
   * Selector-level input. Kept on the backend rather than composed from
   * `find()` because the MCP backend has no element references — it drives
   * interactions by node UID and viewport point instead.
   */
  click(selector: string, options: ClickOptions): Promise<void>;
  type(selector: string, text: string, options: { delay?: number }): Promise<void>;
  hover(selector: string): Promise<void>;
  focus(selector: string): Promise<void>;
  tap(selector: string): Promise<void>;
  select(selector: string, values: string[]): Promise<string[]>;

  // --- Capture ---------------------------------------------------------------

  /** Base64 PNG. `fullPage` is native on some backends and emulated on others. */
  screenshot(options: ScreenshotOptions): Promise<string>;
  setViewport(viewport: Viewport): Promise<void>;
  windowRect(): Promise<Rect>;
  setWindowRect(rect: Partial<Rect>): Promise<Rect>;
  maximize(): Promise<void>;

  // --- Cookies ---------------------------------------------------------------

  cookies(): Promise<WebDriverCookie[]>;
  addCookie(cookie: WebDriverCookie): Promise<void>;
  deleteCookie(name: string): Promise<void>;
  deleteAllCookies(): Promise<void>;

  // --- Frames ----------------------------------------------------------------

  enterFrame(target: number | ElementHandle): Promise<void>;
  exitFrame(): Promise<void>;
  exitAllFrames(): Promise<void>;

  // --- Observation -----------------------------------------------------------

  /** Install whatever is needed before console messages can be drained. */
  prepareConsole(): Promise<void>;
  /** Messages recorded since the last drain. */
  drainConsole(): Promise<ConsoleRecord[]>;

  /** The open dialog, or null. */
  pendingDialog(): Promise<Dialog | null>;

  /** Read-only network inspection, when the backend has any. */
  networkRequests(options: { clear?: boolean; filter?: string }): Promise<unknown>;

  /** CSS media type override (`'screen'`, `'print'`, `''` to clear). */
  setEmulatedMediaType(media: string): Promise<void>;

  // --- Lifecycle -------------------------------------------------------------

  close(): Promise<void>;
}
