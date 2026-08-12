/**
 * Error types. These intentionally mirror Puppeteer's error names so that code
 * written against Puppeteer (`err.name === 'TimeoutError'`) keeps working.
 */

export class SafariPuppeteerError extends Error {
  override name = 'SafariPuppeteerError';
}

/** Thrown when a wait helper exceeds its deadline. Matches Puppeteer's name. */
export class TimeoutError extends SafariPuppeteerError {
  override name = 'TimeoutError';
}

/** Thrown when a target (page/frame/element) has gone away. */
export class TargetCloseError extends SafariPuppeteerError {
  override name = 'TargetCloseError';
}

/**
 * Thrown for Puppeteer APIs that have no counterpart in the classic W3C
 * WebDriver protocol that safaridriver speaks. The message always explains
 * *why* and points at the closest supported alternative, so callers (and
 * agents) can recover without guessing.
 */
export class UnsupportedOperationError extends SafariPuppeteerError {
  override name = 'UnsupportedOperationError';

  constructor(api: string, reason: string, alternative?: string) {
    super(
      `${api} is not supported when driving real Safari.\n` +
        `Reason: ${reason}` +
        (alternative ? `\nAlternative: ${alternative}` : ''),
    );
  }
}

/** A W3C WebDriver protocol-level error returned by safaridriver. */
export class WebDriverError extends SafariPuppeteerError {
  override name = 'WebDriverError';

  /** W3C error code, e.g. `no such element`, `stale element reference`. */
  readonly code: string;
  /** Driver-supplied stack trace, when present. */
  readonly stacktrace: string | undefined;

  // Written as explicit fields rather than parameter properties so the source
  // runs under `node --experimental-strip-types` without a compile step.
  constructor(code: string, message: string, stacktrace?: string) {
    super(message);
    this.code = code;
    this.stacktrace = stacktrace;
  }
}

/** safaridriver could not be started or the environment is not set up. */
export class SafariDriverError extends SafariPuppeteerError {
  override name = 'SafariDriverError';
}
