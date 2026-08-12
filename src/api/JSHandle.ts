import { SafariPuppeteerError, UnsupportedOperationError } from '../common/errors.ts';
import { poll } from '../common/util.ts';
import type { Rect } from '../webdriver/client.ts';
import { ExecutionContext, type HandleDescriptor, type Serializable } from './ExecutionContext.ts';

/**
 * A reference to an in-page JavaScript value.
 *
 * Backed by the page-side registry in {@link ExecutionContext}. Handles do not
 * survive navigation, since the registry lives on `window`.
 */
export class JSHandle implements Serializable {
  protected readonly context: ExecutionContext;
  protected readonly descriptor: HandleDescriptor;
  #disposed = false;

  constructor(context: ExecutionContext, descriptor: HandleDescriptor) {
    this.context = context;
    this.descriptor = descriptor;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Downcast to {@link ElementHandle} when this value is a DOM element. */
  asElement(): ElementHandle | null {
    return this instanceof ElementHandle ? this : null;
  }

  /** How this handle is tunnelled into a later `evaluate` call. */
  toScriptArg(): unknown {
    this.#assertUsable();
    // An element reference is the better wire form when we have one: the
    // driver validates it and it survives without the registry.
    if (this.descriptor.elementId !== null) {
      return ExecutionContext.elementArg(this.descriptor.elementId);
    }
    return ExecutionContext.handleArg(this.descriptor.id);
  }

  /** Evaluate `fn` with this handle as the first argument, returning JSON. */
  evaluate<T = unknown>(fn: Function | string, ...args: unknown[]): Promise<T> {
    this.#assertUsable();
    return this.context.evaluate<T>(fn, this, ...args);
  }

  /** Evaluate `fn` with this handle as the first argument, returning a handle. */
  async evaluateHandle(fn: Function | string, ...args: unknown[]): Promise<JSHandle> {
    this.#assertUsable();
    const descriptor = await this.context.evaluateHandle(fn, this, ...args);
    return createHandle(this.context, descriptor);
  }

  /** Read a single own property as a new handle. */
  getProperty(name: string): Promise<JSHandle> {
    return this.evaluateHandle((object: any, key: string) => object[key], name);
  }

  /** Read every own enumerable property as handles. */
  async getProperties(): Promise<Map<string, JSHandle>> {
    const names = await this.evaluate<string[]>((object: any) => {
      if (object === null || typeof object !== 'object') return [];
      return Object.getOwnPropertyNames(object);
    });

    const entries = await Promise.all(
      names.map(async (name) => [name, await this.getProperty(name)] as const),
    );
    return new Map(entries);
  }

  /** Serialize the underlying value to JSON, as `JSHandle.jsonValue()` does. */
  jsonValue<T = unknown>(): Promise<T> {
    return this.evaluate<T>((object: any) => object);
  }

  /** Drop the page-side reference. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.context.releaseHandle(this.descriptor.id);
  }

  toString(): string {
    const { type, className } = this.descriptor;
    return `JSHandle@${className ?? type}`;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new SafariPuppeteerError('This handle was disposed and can no longer be used.');
    }
  }
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  /** Click at this offset from the element's top-left instead of its centre. */
  offset?: { x: number; y: number };
}

/** A handle to a DOM element, with the element-specific half of the API. */
export class ElementHandle extends JSHandle {
  /** The WebDriver element id, used for driver-native element commands. */
  get elementId(): string {
    const id = this.descriptor.elementId;
    if (id === null) {
      throw new SafariPuppeteerError('This handle does not reference a DOM element.');
    }
    return id;
  }

  override asElement(): ElementHandle {
    return this;
  }

  // --- Querying --------------------------------------------------------------

  async $(selector: string): Promise<ElementHandle | null> {
    const descriptor = await this.context.evaluateHandle(
      (element: Element, sel: string) => element.querySelector(sel),
      this,
      selector,
    );
    if (!descriptor.isElement) {
      await this.context.releaseHandle(descriptor.id);
      return null;
    }
    return new ElementHandle(this.context, descriptor);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const ids = await this.context.client.findElementsFrom(this.elementId, 'css selector', selector);
    return ids.map(
      (elementId) =>
        new ElementHandle(this.context, {
          // These come straight from the driver, so there is no registry entry
          // to release; id 0 marks "not registered".
          id: 0,
          type: 'object',
          className: 'Element',
          isElement: true,
          elementId,
        }),
    );
  }

  async $eval<T = unknown>(selector: string, fn: Function, ...args: unknown[]): Promise<T> {
    const element = await this.$(selector);
    if (element === null) {
      throw new SafariPuppeteerError(`No element matches selector "${selector}".`);
    }
    try {
      return await element.evaluate<T>(fn, ...args);
    } finally {
      await element.dispose();
    }
  }

  $$eval<T = unknown>(selector: string, fn: Function, ...args: unknown[]): Promise<T> {
    return this.evaluate<T>(
      (element: Element, sel: string, fnSource: string, rest: unknown[]) => {
        const nodes = Array.from(element.querySelectorAll(sel));
        // eslint-disable-next-line no-eval
        const callback = eval(`(${fnSource})`);
        return callback(nodes, ...rest);
      },
      selector,
      fn.toString(),
      args,
    );
  }

  /** Find the closest enclosing shadow-including root's host, if any. */
  waitForSelector(selector: string, options: { timeout?: number; visible?: boolean } = {}): Promise<ElementHandle> {
    const timeout = options.timeout ?? 30_000;
    return poll(
      async () => {
        const element = await this.$(selector);
        if (element === null) return null;
        if (options.visible && !(await element.isVisible())) {
          await element.dispose();
          return null;
        }
        return element;
      },
      { timeout, message: `Waiting for selector "${selector}" inside element` },
    );
  }

  // --- Geometry & state ------------------------------------------------------

  /** Bounding box in page coordinates, or null when the element is not rendered. */
  async boundingBox(): Promise<Rect | null> {
    const box = await this.evaluate<Rect | null>((element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    });
    return box;
  }

  /** Viewport-relative rect, which is what the input APIs need. */
  async #viewportRect(): Promise<Rect> {
    const rect = await this.evaluate<Rect>((element: Element) => {
      const r = element.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    return rect;
  }

  /**
   * Whether the element is rendered and visible.
   *
   * Computed in-page rather than via WebDriver's `/element/{id}/displayed`,
   * because safaridriver does not implement that endpoint — it answers
   * `unknown command`. Silently treating that error as "not visible" would make
   * `waitForSelector({ visible: true })` hang until it times out.
   */
  isVisible(): Promise<boolean> {
    return this.evaluate<boolean>((element: Element) => {
      // Safari 17.4+ has the spec algorithm built in; prefer it when present.
      const withCheck = element as Element & {
        checkVisibility?: (options?: Record<string, boolean>) => boolean;
      };
      if (typeof withCheck.checkVisibility === 'function') {
        if (!withCheck.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
      } else {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility !== 'visible') return false;
        if (Number.parseFloat(style.opacity) === 0) return false;
      }

      // `checkVisibility` reports true for zero-area elements, which is not
      // what "visible" means for the purpose of clicking one.
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  isHidden(): Promise<boolean> {
    return this.isVisible().then((visible) => !visible);
  }

  isEnabled(): Promise<boolean> {
    return this.context.client.isElementEnabled(this.elementId);
  }

  /** Checked state for checkboxes/radios, selected state for `<option>`. */
  isSelected(): Promise<boolean> {
    return this.context.client.isElementSelected(this.elementId);
  }

  /** Rendered text, as the driver computes it (respects visibility). */
  textContent(): Promise<string> {
    return this.context.client.getElementText(this.elementId);
  }

  /**
   * Lowercase tag name.
   *
   * safaridriver returns the uppercase HTML name (`H1`), so it is normalized
   * here — callers should not have to case-fold defensively.
   */
  async tagName(): Promise<string> {
    const name = await this.context.client.getElementTagName(this.elementId);
    return name.toLowerCase();
  }

  getAttribute(name: string): Promise<string | null> {
    return this.context.client.getElementAttribute(this.elementId, name);
  }

  getCssValue(name: string): Promise<string> {
    return this.context.client.getElementCssValue(this.elementId, name);
  }

  // --- Interaction -----------------------------------------------------------

  /** Scroll the element into view if needed. */
  async scrollIntoView(): Promise<void> {
    await this.evaluate((element: Element) => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    });
  }

  /**
   * Click the element.
   *
   * A plain left click with no offset uses the driver's native element click,
   * which handles scrolling and hit-testing. Anything else needs the Actions
   * API against computed coordinates.
   */
  async click(options: ClickOptions = {}): Promise<void> {
    const isSimple =
      (options.button ?? 'left') === 'left' &&
      (options.clickCount ?? 1) === 1 &&
      !options.delay &&
      !options.offset;

    if (isSimple) {
      await this.context.client.clickElement(this.elementId);
      return;
    }

    await this.scrollIntoView();
    const rect = await this.#viewportRect();
    const x = Math.round(rect.x + (options.offset?.x ?? rect.width / 2));
    const y = Math.round(rect.y + (options.offset?.y ?? rect.height / 2));

    const button = { left: 0, middle: 1, right: 2 }[options.button ?? 'left'];
    const actions: unknown[] = [
      { type: 'pointerMove', duration: 0, origin: 'viewport', x, y },
    ];
    for (let i = 0; i < (options.clickCount ?? 1); i++) {
      actions.push({ type: 'pointerDown', button });
      if (options.delay) actions.push({ type: 'pause', duration: options.delay });
      actions.push({ type: 'pointerUp', button });
    }

    await this.context.client.performActions([
      { type: 'pointer', id: 'safari-puppeteer-mouse', parameters: { pointerType: 'mouse' }, actions },
    ]);
  }

  /** Move the pointer over the element without clicking. */
  async hover(): Promise<void> {
    await this.scrollIntoView();
    const rect = await this.#viewportRect();
    await this.context.client.performActions([
      {
        type: 'pointer',
        id: 'safari-puppeteer-mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          {
            type: 'pointerMove',
            duration: 0,
            origin: 'viewport',
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
        ],
      },
    ]);
  }

  async tap(): Promise<void> {
    await this.scrollIntoView();
    const rect = await this.#viewportRect();
    await this.context.client.performActions([
      {
        type: 'pointer',
        id: 'safari-puppeteer-touch',
        parameters: { pointerType: 'touch' },
        actions: [
          {
            type: 'pointerMove',
            duration: 0,
            origin: 'viewport',
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 50 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  }

  async focus(): Promise<void> {
    await this.evaluate((element: HTMLElement) => element.focus());
  }

  /** Focus the element and type into it. Does not clear existing content. */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    if (!options.delay) {
      await this.context.client.sendKeysToElement(this.elementId, text);
      return;
    }
    await this.focus();
    const actions: unknown[] = [];
    for (const char of [...text]) {
      actions.push({ type: 'keyDown', value: char });
      actions.push({ type: 'keyUp', value: char });
      actions.push({ type: 'pause', duration: options.delay });
    }
    await this.context.client.performActions([
      { type: 'key', id: 'safari-puppeteer-keyboard', actions },
    ]);
  }

  /** Press a single key while this element is focused. */
  async press(key: string, options: { delay?: number } = {}): Promise<void> {
    await this.focus();
    const { resolveKey } = await import('./USKeyboardLayout.ts');
    const value = resolveKey(key);
    const actions: unknown[] = [{ type: 'keyDown', value }];
    if (options.delay) actions.push({ type: 'pause', duration: options.delay });
    actions.push({ type: 'keyUp', value });
    await this.context.client.performActions([
      { type: 'key', id: 'safari-puppeteer-keyboard', actions },
    ]);
  }

  /** Clear the value of an input or textarea. */
  clear(): Promise<void> {
    return this.context.client.clearElement(this.elementId);
  }

  /**
   * Select `<option>`s in a `<select>` by value, returning the values actually
   * selected — matching `page.select()` semantics.
   */
  select(...values: string[]): Promise<string[]> {
    return this.evaluate<string[]>((element: HTMLSelectElement, wanted: string[]) => {
      if (element.nodeName.toLowerCase() !== 'select') {
        throw new Error('select() requires a <select> element.');
      }
      const set = new Set(wanted);
      const options = Array.from(element.options);
      const selected: string[] = [];

      if (element.multiple) {
        for (const option of options) {
          option.selected = set.has(option.value);
          if (option.selected) selected.push(option.value);
        }
      } else {
        // Single-select needs care: assigning `selected = false` to the only
        // selected option triggers HTML's "ask for a reset" algorithm, which
        // immediately re-selects the first option. Toggling option-by-option
        // therefore reads back the wrong value. Select the one match directly.
        const match = options.find((option) => set.has(option.value));
        if (match) {
          match.selected = true;
          selected.push(match.value);
        }
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return selected;
    }, values);
  }

  /**
   * Set the files of an `<input type="file">`.
   *
   * Implemented via the spec's "send keys to a file input" behaviour, which
   * safaridriver's support for is historically inconsistent — verify against
   * your Safari version before relying on it.
   */
  async uploadFile(...filePaths: string[]): Promise<void> {
    const tag = (await this.tagName()).toLowerCase();
    const type = (await this.getAttribute('type'))?.toLowerCase();
    if (tag !== 'input' || type !== 'file') {
      throw new SafariPuppeteerError('uploadFile() requires an <input type="file"> element.');
    }
    // Multiple paths are newline-separated per the WebDriver spec.
    await this.context.client.sendKeysToElement(this.elementId, filePaths.join('\n'));
  }

  /** PNG screenshot of just this element. */
  screenshot(options?: { encoding?: 'binary' }): Promise<Buffer>;
  screenshot(options: { encoding: 'base64' }): Promise<string>;
  async screenshot(options: { encoding?: 'binary' | 'base64' } = {}): Promise<Buffer | string> {
    await this.scrollIntoView();
    const base64 = await this.context.client.takeElementScreenshot(this.elementId);
    return options.encoding === 'base64' ? base64 : Buffer.from(base64, 'base64');
  }

  /** Not available: requires CDP's DOM.getContentQuads. */
  contentFrame(): Promise<never> {
    return Promise.reject(
      new UnsupportedOperationError(
        'elementHandle.contentFrame()',
        'WebDriver has no way to map an element reference to a frame object.',
        "Use page.frames() and match on frame.url(), or page.mainFrame().childFrames().",
      ),
    );
  }

  override toString(): string {
    return `ElementHandle@${this.descriptor.className ?? 'Element'}`;
  }
}

/** Build the right handle subclass for a descriptor. */
export function createHandle(context: ExecutionContext, descriptor: HandleDescriptor): JSHandle {
  return descriptor.isElement
    ? new ElementHandle(context, descriptor)
    : new JSHandle(context, descriptor);
}

/** Wrap a bare driver element id (from findElement) as an ElementHandle. */
export function elementHandleFromId(context: ExecutionContext, elementId: string): ElementHandle {
  return new ElementHandle(context, {
    id: 0,
    type: 'object',
    className: 'Element',
    isElement: true,
    elementId,
  });
}
