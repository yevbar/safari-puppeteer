import { WebDriverError } from '../common/errors.ts';

/**
 * Minimal W3C WebDriver client over `fetch`.
 *
 * Only the endpoints this project actually uses are modelled, but `send()` is
 * public so callers can reach any endpoint safaridriver exposes.
 *
 * Spec: https://w3c.github.io/webdriver/
 */

/** The magic key that identifies a web element in W3C WebDriver payloads. */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
/** The equivalent key for shadow roots. */
export const SHADOW_ROOT_KEY = 'shadow-6066-11e4-a52e-4f735466cecf';

export type WebElementRef = { [ELEMENT_KEY]: string };

export function isElementRef(value: unknown): value is WebElementRef {
  return typeof value === 'object' && value !== null && ELEMENT_KEY in value;
}

export function elementRef(id: string): WebElementRef {
  return { [ELEMENT_KEY]: id };
}

export type LocatorStrategy =
  | 'css selector'
  | 'link text'
  | 'partial link text'
  | 'tag name'
  | 'xpath';

export interface Timeouts {
  /** ms the driver waits for document.readyState during navigation. */
  pageLoad?: number;
  /** ms `executeAsyncScript` may run before the driver aborts it. */
  script?: number;
  /** ms the driver retries element location. We keep this at 0 and poll ourselves. */
  implicit?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebDriverCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Unix time in **seconds** (note: Puppeteer uses seconds too). */
  expiry?: number;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

export class WebDriverClient {
  #baseUrl: string;
  #sessionId: string | null = null;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Raw protocol call. Throws {@link WebDriverError} on a W3C error response. */
  async send<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        // safaridriver rejects requests without a recognizable UA on some
        // macOS versions; be explicit.
        'User-Agent': 'safari-puppeteer',
      },
    };
    // The spec requires POST bodies to be JSON objects; send `{}` not `null`.
    if (method === 'POST') init.body = JSON.stringify(body ?? {});

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      throw new WebDriverError(
        'unknown error',
        `Failed to reach safaridriver at ${url}: ${(cause as Error).message}`,
      );
    }

    const text = await response.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new WebDriverError(
        'unknown error',
        `safaridriver returned a non-JSON response (${response.status}): ${text.slice(0, 500)}`,
      );
    }

    // W3C wraps everything in `{ value: ... }`; errors put the details there.
    const value = payload?.value;
    if (!response.ok || (value && typeof value === 'object' && typeof value.error === 'string')) {
      const code: string = value?.error ?? `http ${response.status}`;
      const message: string = value?.message ?? text.slice(0, 500);
      throw new WebDriverError(code, message, value?.stacktrace);
    }

    return value as T;
  }

  /**
   * Send a request scoped to the active session.
   *
   * This is `async` on purpose: a missing session must surface as a *rejected
   * promise*, not a synchronous throw, so that callers can uniformly `.catch()`
   * these methods without also wrapping them in try/catch.
   */
  async #s<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (this.#sessionId === null) {
      throw new WebDriverError('invalid session id', 'No active safaridriver session.');
    }
    return this.send<T>(method, `/session/${this.#sessionId}${path}`, body);
  }

  // --- Session lifecycle -----------------------------------------------------

  async newSession(capabilities: Record<string, unknown>): Promise<{ sessionId: string; capabilities: any }> {
    const result = await this.send<any>('POST', '/session', {
      capabilities: { alwaysMatch: capabilities },
    });
    // safaridriver returns { sessionId, capabilities } inside `value`.
    const sessionId: string = result.sessionId ?? result.capabilities?.sessionId;
    if (!sessionId) {
      throw new WebDriverError('session not created', `Unexpected newSession response: ${JSON.stringify(result)}`);
    }
    this.#sessionId = sessionId;
    return { sessionId, capabilities: result.capabilities ?? {} };
  }

  /**
   * Adopt a session that was created elsewhere.
   *
   * WebDriver has no "attach to session" command, so we set the id and prove it
   * is live with a cheap call that requires a valid session.
   */
  async attachSession(sessionId: string): Promise<void> {
    await this.send('GET', `/session/${sessionId}/window`);
    this.#sessionId = sessionId;
  }

  async deleteSession(): Promise<void> {
    if (this.#sessionId === null) return;
    const id = this.#sessionId;
    // Clear first so a failed teardown cannot leave us retrying forever.
    this.#sessionId = null;
    await this.send('DELETE', `/session/${id}`).catch(() => {});
  }

  setTimeouts(timeouts: Timeouts): Promise<void> {
    return this.#s('POST', '/timeouts', timeouts);
  }

  getTimeouts(): Promise<Required<Timeouts>> {
    return this.#s('GET', '/timeouts');
  }

  // --- Navigation ------------------------------------------------------------

  navigateTo(url: string): Promise<void> {
    return this.#s('POST', '/url', { url });
  }

  getCurrentUrl(): Promise<string> {
    return this.#s('GET', '/url');
  }

  back(): Promise<void> {
    return this.#s('POST', '/back');
  }

  forward(): Promise<void> {
    return this.#s('POST', '/forward');
  }

  refresh(): Promise<void> {
    return this.#s('POST', '/refresh');
  }

  getTitle(): Promise<string> {
    return this.#s('GET', '/title');
  }

  getPageSource(): Promise<string> {
    return this.#s('GET', '/source');
  }

  // --- Window / tab handles --------------------------------------------------

  getWindowHandle(): Promise<string> {
    return this.#s('GET', '/window');
  }

  getWindowHandles(): Promise<string[]> {
    return this.#s('GET', '/window/handles');
  }

  switchToWindow(handle: string): Promise<void> {
    return this.#s('POST', '/window', { handle });
  }

  closeWindow(): Promise<string[]> {
    return this.#s('DELETE', '/window');
  }

  /** `type` is 'tab' or 'window'. Returns the new handle. */
  newWindow(type: 'tab' | 'window' = 'tab'): Promise<{ handle: string; type: string }> {
    return this.#s('POST', '/window/new', { type });
  }

  getWindowRect(): Promise<Rect> {
    return this.#s('GET', '/window/rect');
  }

  setWindowRect(rect: Partial<Rect>): Promise<Rect> {
    return this.#s('POST', '/window/rect', {
      x: rect.x ?? null,
      y: rect.y ?? null,
      width: rect.width ?? null,
      height: rect.height ?? null,
    });
  }

  maximizeWindow(): Promise<Rect> {
    return this.#s('POST', '/window/maximize');
  }

  fullscreenWindow(): Promise<Rect> {
    return this.#s('POST', '/window/fullscreen');
  }

  // --- Frames ----------------------------------------------------------------

  /** `id` may be null (top-level), a number (index), or an element reference. */
  switchToFrame(id: null | number | WebElementRef): Promise<void> {
    return this.#s('POST', '/frame', { id });
  }

  switchToParentFrame(): Promise<void> {
    return this.#s('POST', '/frame/parent');
  }

  // --- Elements --------------------------------------------------------------

  async findElement(using: LocatorStrategy, value: string): Promise<string> {
    const ref = await this.#s<WebElementRef>('POST', '/element', { using, value });
    return ref[ELEMENT_KEY];
  }

  async findElements(using: LocatorStrategy, value: string): Promise<string[]> {
    const refs = await this.#s<WebElementRef[]>('POST', '/elements', { using, value });
    return refs.map((ref) => ref[ELEMENT_KEY]);
  }

  async findElementFrom(elementId: string, using: LocatorStrategy, value: string): Promise<string> {
    const ref = await this.#s<WebElementRef>('POST', `/element/${elementId}/element`, {
      using,
      value,
    });
    return ref[ELEMENT_KEY];
  }

  async findElementsFrom(elementId: string, using: LocatorStrategy, value: string): Promise<string[]> {
    const refs = await this.#s<WebElementRef[]>('POST', `/element/${elementId}/elements`, {
      using,
      value,
    });
    return refs.map((ref) => ref[ELEMENT_KEY]);
  }

  async getActiveElement(): Promise<string> {
    const ref = await this.#s<WebElementRef>('GET', '/element/active');
    return ref[ELEMENT_KEY];
  }

  clickElement(elementId: string): Promise<void> {
    return this.#s('POST', `/element/${elementId}/click`);
  }

  clearElement(elementId: string): Promise<void> {
    return this.#s('POST', `/element/${elementId}/clear`);
  }

  sendKeysToElement(elementId: string, text: string): Promise<void> {
    return this.#s('POST', `/element/${elementId}/value`, {
      text,
      // Some drivers still read the legacy `value` array; send both.
      value: [...text],
    });
  }

  getElementText(elementId: string): Promise<string> {
    return this.#s('GET', `/element/${elementId}/text`);
  }

  getElementTagName(elementId: string): Promise<string> {
    return this.#s('GET', `/element/${elementId}/name`);
  }

  getElementAttribute(elementId: string, name: string): Promise<string | null> {
    return this.#s('GET', `/element/${elementId}/attribute/${name}`);
  }

  getElementProperty(elementId: string, name: string): Promise<unknown> {
    return this.#s('GET', `/element/${elementId}/property/${name}`);
  }

  getElementCssValue(elementId: string, name: string): Promise<string> {
    return this.#s('GET', `/element/${elementId}/css/${name}`);
  }

  getElementRect(elementId: string): Promise<Rect> {
    return this.#s('GET', `/element/${elementId}/rect`);
  }

  isElementEnabled(elementId: string): Promise<boolean> {
    return this.#s('GET', `/element/${elementId}/enabled`);
  }

  isElementSelected(elementId: string): Promise<boolean> {
    return this.#s('GET', `/element/${elementId}/selected`);
  }

  /**
   * Not implemented by safaridriver — it answers `unknown command`. Kept for
   * protocol completeness against other drivers; {@link ElementHandle.isVisible}
   * computes visibility in-page instead.
   */
  isElementDisplayed(elementId: string): Promise<boolean> {
    return this.#s('GET', `/element/${elementId}/displayed`);
  }

  // --- Script execution ------------------------------------------------------

  executeScript<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    return this.#s('POST', '/execute/sync', { script, args });
  }

  /** The script receives a completion callback as its last argument. */
  executeAsyncScript<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    return this.#s('POST', '/execute/async', { script, args });
  }

  // --- Cookies ---------------------------------------------------------------

  getCookies(): Promise<WebDriverCookie[]> {
    return this.#s('GET', '/cookie');
  }

  getCookie(name: string): Promise<WebDriverCookie> {
    return this.#s('GET', `/cookie/${name}`);
  }

  addCookie(cookie: WebDriverCookie): Promise<void> {
    return this.#s('POST', '/cookie', { cookie });
  }

  deleteCookie(name: string): Promise<void> {
    return this.#s('DELETE', `/cookie/${name}`);
  }

  deleteAllCookies(): Promise<void> {
    return this.#s('DELETE', '/cookie');
  }

  // --- Actions (keyboard / mouse / touch) ------------------------------------

  performActions(actions: unknown[]): Promise<void> {
    return this.#s('POST', '/actions', { actions });
  }

  releaseActions(): Promise<void> {
    return this.#s('DELETE', '/actions');
  }

  // --- User prompts (alert / confirm / prompt) -------------------------------

  dismissAlert(): Promise<void> {
    return this.#s('POST', '/alert/dismiss');
  }

  acceptAlert(): Promise<void> {
    return this.#s('POST', '/alert/accept');
  }

  getAlertText(): Promise<string> {
    return this.#s('GET', '/alert/text');
  }

  sendAlertText(text: string): Promise<void> {
    return this.#s('POST', '/alert/text', { text });
  }

  // --- Screenshots -----------------------------------------------------------

  /** Base64-encoded PNG of the current viewport. */
  takeScreenshot(): Promise<string> {
    return this.#s('GET', '/screenshot');
  }

  /** Base64-encoded PNG of a single element. */
  takeElementScreenshot(elementId: string): Promise<string> {
    return this.#s('GET', `/element/${elementId}/screenshot`);
  }

  // --- Status ----------------------------------------------------------------

  /** Server readiness. Works without a session — used for health checks. */
  status(): Promise<{ ready: boolean; message: string }> {
    return this.send('GET', '/status');
  }
}
