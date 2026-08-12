import { SafariPuppeteerError } from '../common/errors.ts';
import { ELEMENT_KEY, elementRef, type WebDriverClient } from '../webdriver/client.ts';

/**
 * Bridges Puppeteer's `evaluate`/`evaluateHandle` onto WebDriver's
 * `executeScript`.
 *
 * The problem this solves: CDP can hand back a *remote object reference* for
 * any JS value, so `page.evaluateHandle(() => window.foo)` gives you a live
 * handle. WebDriver can only return JSON-serializable values plus element
 * references. So for non-element values we keep a registry inside the page
 * (`window[REGISTRY]`) that maps integer ids to live objects, and a handle is
 * just an id. Passing a handle back into a later `evaluate` resolves it through
 * that registry.
 *
 * Consequence worth knowing: the registry lives on `window`, so all handles are
 * invalidated by navigation. `disposed`/`stale` handles throw a clear error
 * rather than silently returning undefined.
 */

const REGISTRY = '__safariPuppeteerRegistry__';
/** Marker object used to tunnel a handle id through WebDriver's JSON args. */
const HANDLE_MARKER = '__safariPuppeteerHandleId__';

/** Installed once per document; idempotent so we can call it freely. */
const REGISTRY_BOOTSTRAP = `
  if (!window.${REGISTRY}) {
    Object.defineProperty(window, '${REGISTRY}', {
      value: { objects: new Map(), nextId: 1 },
      enumerable: false, configurable: true, writable: true
    });
  }
`;

/**
 * Prelude prepended to every evaluated script. Defines `__spResolve` (turn
 * handle markers in the args back into live objects) and `__spStore` (register
 * a value and return its id).
 */
const PRELUDE = `
  ${REGISTRY_BOOTSTRAP}
  var __spReg = window.${REGISTRY};
  function __spResolve(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Object.prototype.hasOwnProperty.call(value, '${HANDLE_MARKER}')) {
      var id = value['${HANDLE_MARKER}'];
      if (!__spReg.objects.has(id)) {
        throw new Error('safari-puppeteer: handle ' + id + ' is no longer valid (the page likely navigated).');
      }
      return __spReg.objects.get(id);
    }
    if (Array.isArray(value)) return value.map(__spResolve);
    return value;
  }
  function __spStore(value) {
    var id = __spReg.nextId++;
    __spReg.objects.set(id, value);
    return id;
  }
`;

export type HandleArg = unknown;

/** Anything that can serialize itself into a WebDriver script argument. */
export interface Serializable {
  /** Returns the value to place in the `args` array. */
  toScriptArg(): unknown;
}

function isSerializable(value: unknown): value is Serializable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Serializable).toScriptArg === 'function'
  );
}

/** Convert user-supplied evaluate args into WebDriver-safe script args. */
export function serializeArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => {
    if (isSerializable(arg)) return arg.toScriptArg();
    if (typeof arg === 'function') {
      throw new SafariPuppeteerError(
        'Functions cannot be passed as evaluate() arguments — they are not serializable. ' +
          'Pass the source as a string and reconstruct it inside the page instead.',
      );
    }
    if (typeof arg === 'bigint') {
      throw new SafariPuppeteerError('BigInt arguments are not JSON-serializable.');
    }
    if (typeof arg === 'undefined') return null;
    return arg;
  });
}

/** Describes a value stored in the page registry. */
export interface HandleDescriptor {
  id: number;
  type: string;
  className: string | null;
  isElement: boolean;
  /** Present when the value is a DOM element, so it can drive WebDriver APIs. */
  elementId: string | null;
}

export class ExecutionContext {
  #client: WebDriverClient;

  constructor(client: WebDriverClient) {
    this.#client = client;
  }

  get client(): WebDriverClient {
    return this.#client;
  }

  /**
   * Evaluate `fn` in the page and return its JSON value.
   *
   * `fn` may be a function (called with `args`) or an expression string.
   */
  async evaluate<T = unknown>(fn: Function | string, ...args: unknown[]): Promise<T> {
    const script = this.#buildScript(fn, args.length, /* asHandle */ false);
    return this.#client.executeScript<T>(script, serializeArgs(args));
  }

  /** Evaluate `fn` and register the result, returning a descriptor for it. */
  async evaluateHandle(fn: Function | string, ...args: unknown[]): Promise<HandleDescriptor> {
    const script = this.#buildScript(fn, args.length, /* asHandle */ true);
    const raw = await this.#client.executeScript<[number, string, string | null, unknown]>(
      script,
      serializeArgs(args),
    );

    const [id, type, className, elementValue] = raw;
    // When the value is an Element, the driver serializes it into an element
    // reference for us — that is what makes click/screenshot work on handles.
    let elementId: string | null = null;
    if (elementValue && typeof elementValue === 'object' && ELEMENT_KEY in (elementValue as object)) {
      elementId = (elementValue as Record<string, string>)[ELEMENT_KEY] ?? null;
    }

    return { id, type, className, isElement: elementId !== null, elementId };
  }

  /** Release a registry entry so the page can garbage-collect the value. */
  async releaseHandle(id: number): Promise<void> {
    await this.#client
      .executeScript(
        `${REGISTRY_BOOTSTRAP} window.${REGISTRY}.objects.delete(arguments[0]);`,
        [id],
      )
      // A navigated-away page has no registry left to clean; that is fine.
      .catch(() => {});
  }

  /** The script argument form of a registry handle. */
  static handleArg(id: number): Record<string, number> {
    return { [HANDLE_MARKER]: id };
  }

  /** The script argument form of an element reference. */
  static elementArg(elementId: string): unknown {
    return elementRef(elementId);
  }

  /**
   * Assemble the final script body.
   *
   * Arguments arrive as `arguments[0..n]`; each is passed through
   * `__spResolve` so handle markers become live objects before `fn` sees them.
   */
  #buildScript(fn: Function | string, argCount: number, asHandle: boolean): string {
    const resolvedArgs = Array.from({ length: argCount }, (_, i) => `__spResolve(arguments[${i}])`);

    const invocation =
      typeof fn === 'string'
        ? // A bare expression. Puppeteer evaluates it as-is and ignores args.
          `(${fn})`
        : `(${fn.toString()})(${resolvedArgs.join(', ')})`;

    if (!asHandle) {
      return `${PRELUDE} return ${invocation};`;
    }

    return `
      ${PRELUDE}
      var __spValue = ${invocation};
      var __spId = __spStore(__spValue);
      var __spType = __spValue === null ? 'object' : typeof __spValue;
      var __spClass = null;
      try {
        __spClass = (__spValue !== null && __spValue !== undefined && __spValue.constructor)
          ? __spValue.constructor.name : null;
      } catch (e) {}
      var __spEl = (typeof Element !== 'undefined' && __spValue instanceof Element) ? __spValue : null;
      return [__spId, __spType, __spClass, __spEl];
    `;
  }
}

export { REGISTRY as REGISTRY_KEY, HANDLE_MARKER };
