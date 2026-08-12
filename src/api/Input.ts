import type { WebDriverClient } from '../webdriver/client.ts';
import { MODIFIER_KEYS, resolveKey } from './USKeyboardLayout.ts';

/**
 * Puppeteer's `keyboard`/`mouse`/`touchscreen` implemented on top of the W3C
 * Actions API.
 *
 * The key difference from CDP: WebDriver actions are *transactional*. Each
 * `performActions` call is an independent sequence, and any keys still held at
 * the end of a sequence stay held until `releaseActions`. So `keyboard.down()`
 * has to record its own state — we replay held modifiers on every subsequent
 * sequence, which is what CDP does implicitly.
 */

const KEYBOARD_ID = 'safari-puppeteer-keyboard';
const MOUSE_ID = 'safari-puppeteer-mouse';
const TOUCH_ID = 'safari-puppeteer-touch';

export type MouseButtonName = 'left' | 'right' | 'middle' | 'back' | 'forward';

const MOUSE_BUTTON_CODES: Record<MouseButtonName, number> = {
  left: 0,
  middle: 1,
  right: 2,
  back: 3,
  forward: 4,
};

export interface KeyboardTypeOptions {
  /** ms between keystrokes. */
  delay?: number;
}

export interface KeyDownOptions {
  /** Text to insert instead of the key's default character. */
  text?: string;
}

export class Keyboard {
  #client: WebDriverClient;
  /** Keys currently held down via `down()` without a matching `up()`. */
  #pressed = new Set<string>();

  constructor(client: WebDriverClient) {
    this.#client = client;
  }

  /** Modifiers held down, replayed at the start of each new action sequence. */
  get heldModifiers(): string[] {
    return [...this.#pressed].filter((key) => MODIFIER_KEYS.has(key));
  }

  async down(key: string, _options: KeyDownOptions = {}): Promise<void> {
    const value = resolveKey(key);
    await this.#client.performActions([
      {
        type: 'key',
        id: KEYBOARD_ID,
        actions: [{ type: 'keyDown', value }],
      },
    ]);
    this.#pressed.add(key);
  }

  async up(key: string): Promise<void> {
    const value = resolveKey(key);
    await this.#client.performActions([
      {
        type: 'key',
        id: KEYBOARD_ID,
        actions: [{ type: 'keyUp', value }],
      },
    ]);
    this.#pressed.delete(key);
  }

  /** Press and release a single key, optionally holding it for `delay` ms. */
  async press(key: string, options: KeyboardTypeOptions = {}): Promise<void> {
    const value = resolveKey(key);
    const actions: unknown[] = [{ type: 'keyDown', value }];
    if (options.delay) actions.push({ type: 'pause', duration: options.delay });
    actions.push({ type: 'keyUp', value });

    await this.#client.performActions([{ type: 'key', id: KEYBOARD_ID, actions }]);
  }

  /**
   * Type literal text, one character at a time.
   *
   * Unlike `press`, this sends raw characters and does not interpret key names,
   * matching Puppeteer's `keyboard.type` semantics.
   */
  async type(text: string, options: KeyboardTypeOptions = {}): Promise<void> {
    const chars = [...text];

    if (!options.delay) {
      // Fast path: one sequence for the whole string.
      const actions = chars.flatMap((char) => [
        { type: 'keyDown', value: char },
        { type: 'keyUp', value: char },
      ]);
      if (actions.length === 0) return;
      await this.#client.performActions([{ type: 'key', id: KEYBOARD_ID, actions }]);
      return;
    }

    const actions: unknown[] = [];
    for (const char of chars) {
      actions.push({ type: 'keyDown', value: char });
      actions.push({ type: 'keyUp', value: char });
      actions.push({ type: 'pause', duration: options.delay });
    }
    if (actions.length === 0) return;
    await this.#client.performActions([{ type: 'key', id: KEYBOARD_ID, actions }]);
  }

  /** Insert text directly without synthesizing per-key events. */
  async sendCharacter(char: string): Promise<void> {
    await this.type(char);
  }

  /** Release every key/button held by this session. */
  async reset(): Promise<void> {
    this.#pressed.clear();
    await this.#client.releaseActions().catch(() => {});
  }
}

export interface MouseMoveOptions {
  /** Number of intermediate move events. Puppeteer defaults to 1. */
  steps?: number;
}

export interface MouseClickOptions extends MouseMoveOptions {
  button?: MouseButtonName;
  /** ms held between press and release. */
  delay?: number;
  /** Number of clicks; 2 produces a double-click. */
  count?: number;
}

export class Mouse {
  #client: WebDriverClient;
  #x = 0;
  #y = 0;

  constructor(client: WebDriverClient) {
    this.#client = client;
  }

  /** Last known pointer position, in CSS pixels relative to the viewport. */
  get position(): { x: number; y: number } {
    return { x: this.#x, y: this.#y };
  }

  async move(x: number, y: number, options: MouseMoveOptions = {}): Promise<void> {
    const steps = Math.max(1, options.steps ?? 1);
    const fromX = this.#x;
    const fromY = this.#y;

    const actions: unknown[] = [];
    for (let i = 1; i <= steps; i++) {
      actions.push({
        type: 'pointerMove',
        duration: 0,
        // `viewport` origin means the coordinates are absolute in the viewport,
        // which is what Puppeteer's mouse API promises.
        origin: 'viewport',
        x: Math.round(fromX + (x - fromX) * (i / steps)),
        y: Math.round(fromY + (y - fromY) * (i / steps)),
      });
    }

    await this.#perform(actions);
    this.#x = x;
    this.#y = y;
  }

  async down(options: { button?: MouseButtonName } = {}): Promise<void> {
    await this.#perform([
      { type: 'pointerDown', button: MOUSE_BUTTON_CODES[options.button ?? 'left'] },
    ]);
  }

  async up(options: { button?: MouseButtonName } = {}): Promise<void> {
    await this.#perform([
      { type: 'pointerUp', button: MOUSE_BUTTON_CODES[options.button ?? 'left'] },
    ]);
  }

  /** Move to (x, y) then press and release. */
  async click(x: number, y: number, options: MouseClickOptions = {}): Promise<void> {
    const button = MOUSE_BUTTON_CODES[options.button ?? 'left'];
    const count = options.count ?? 1;
    const steps = Math.max(1, options.steps ?? 1);

    const actions: unknown[] = [];
    const fromX = this.#x;
    const fromY = this.#y;
    for (let i = 1; i <= steps; i++) {
      actions.push({
        type: 'pointerMove',
        duration: 0,
        origin: 'viewport',
        x: Math.round(fromX + (x - fromX) * (i / steps)),
        y: Math.round(fromY + (y - fromY) * (i / steps)),
      });
    }

    for (let i = 0; i < count; i++) {
      actions.push({ type: 'pointerDown', button });
      if (options.delay) actions.push({ type: 'pause', duration: options.delay });
      actions.push({ type: 'pointerUp', button });
    }

    await this.#perform(actions);
    this.#x = x;
    this.#y = y;
  }

  /**
   * Scroll by a delta. WebDriver models this as a separate `wheel` input
   * source, so it does not go through the pointer sequence.
   */
  async wheel(options: { deltaX?: number; deltaY?: number } = {}): Promise<void> {
    await this.#client.performActions([
      {
        type: 'wheel',
        id: 'safari-puppeteer-wheel',
        actions: [
          {
            type: 'scroll',
            x: Math.round(this.#x),
            y: Math.round(this.#y),
            deltaX: Math.round(options.deltaX ?? 0),
            deltaY: Math.round(options.deltaY ?? 0),
            duration: 0,
            origin: 'viewport',
          },
        ],
      },
    ]);
  }

  /** Press at `from`, move to `to`, release. Convenience for HTML5 drag. */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.move(from.x, from.y);
    await this.down();
    // Intermediate steps make drag handlers that require movement actually fire.
    await this.move(to.x, to.y, { steps: 10 });
    await this.up();
  }

  #perform(actions: unknown[]): Promise<void> {
    return this.#client.performActions([
      {
        type: 'pointer',
        id: MOUSE_ID,
        parameters: { pointerType: 'mouse' },
        actions,
      },
    ]);
  }

  async reset(): Promise<void> {
    this.#x = 0;
    this.#y = 0;
    await this.#client.releaseActions().catch(() => {});
  }
}

export class Touchscreen {
  #client: WebDriverClient;

  constructor(client: WebDriverClient) {
    this.#client = client;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.#client.performActions([
      {
        type: 'pointer',
        id: TOUCH_ID,
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: 'viewport', x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 50 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
  }
}
