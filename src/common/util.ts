import { TimeoutError } from './errors.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOptions {
  /** Total budget in ms. */
  timeout: number;
  /** Delay between attempts in ms. */
  interval?: number;
  /** Message used for the TimeoutError. */
  message: string;
}

/**
 * Poll `fn` until it returns a non-null/non-false value or the timeout expires.
 *
 * Polling is the backbone of this library: classic WebDriver is request/response
 * with no event stream, so every "wait for X" in the Puppeteer API becomes a
 * poll loop over `executeScript` or a driver query.
 */
export async function poll<T>(
  fn: () => Promise<T>,
  { timeout, interval = 50, message }: PollOptions,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  for (;;) {
    try {
      const value = await fn();
      if (value !== null && value !== undefined && value !== false) {
        return value as NonNullable<T>;
      }
      lastError = undefined;
    } catch (error) {
      // Transient errors (stale elements mid-navigation, for example) are
      // expected while polling; only the final one is surfaced.
      lastError = error;
    }

    if (Date.now() >= deadline) {
      const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
      throw new TimeoutError(`${message} (timeout ${timeout}ms).${suffix}`);
    }

    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

/** Reject with a TimeoutError if `promise` does not settle within `timeout`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  message: string,
): Promise<T> {
  if (timeout <= 0) return promise;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${message} (timeout ${timeout}ms).`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Serialize a function + args into the string body that WebDriver's
 * `executeScript` expects. Puppeteer accepts either a function or an
 * expression string in `page.evaluate`, so we normalize both here.
 */
export function toEvaluationBody(fn: Function | string): string {
  if (typeof fn === 'string') {
    // A bare expression: wrap so its completion value is returned.
    return `return (${fn});`;
  }
  return `return (${fn.toString()}).apply(null, arguments);`;
}

/** Find a free TCP port by binding to :0 and releasing it. */
export async function getFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to acquire a free port.'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
