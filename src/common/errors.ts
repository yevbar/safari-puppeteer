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

/**
 * A failure from the `safaridriver --mcp` server: transport, handshake, or a
 * tool call that came back flagged as an error.
 */
export class McpError extends SafariPuppeteerError {
  override name = 'McpError';

  /** JSON-RPC error code, when the failure came back as a protocol error. */
  readonly code: number | undefined;
  /** Tool name, when the failure came from `tools/call`. */
  readonly tool: string | undefined;

  constructor(message: string, options: { code?: number; tool?: string } = {}) {
    super(message);
    this.code = options.code;
    this.tool = options.tool;
  }
}
