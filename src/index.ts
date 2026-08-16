import { SafariApp } from './applescript/safari.ts';
import { McpSession, WebDriverSession } from './backend/sessions.ts';
import type { BackendName } from './backend/types.ts';
import { McpError, SafariDriverError, UnsupportedOperationError } from './common/errors.ts';
import { Browser } from './api/Browser.ts';
import type { Viewport } from './api/Page.ts';
import { WebDriverClient } from './webdriver/client.ts';
import {
  DEFAULT_SAFARIDRIVER,
  REMOTE_AUTOMATION_HINT,
  SafariDriverProcess,
  TECH_PREVIEW_SAFARIDRIVER,
} from './webdriver/safaridriver.ts';

export interface LaunchOptions {
  /**
   * Accepted for Puppeteer compatibility, but Safari has no headless mode.
   * Passing `true` throws rather than silently running headful.
   */
  headless?: boolean;
  /** Viewport applied to each new page. Pass `null` to leave windows as-is. */
  defaultViewport?: Viewport | null;
  /** Path to safaridriver. Defaults to /usr/bin/safaridriver. */
  safaridriverPath?: string;
  /** Fixed port for the driver. Defaults to an ephemeral free port. */
  port?: number;
  /** Pipe safaridriver's output to this process. */
  dumpio?: boolean;
  /** Pass `--diagnose` to safaridriver for verbose driver logs. */
  diagnose?: boolean;
  /** Application name for the AppleScript bridge. */
  appName?: string;
  /** Extra W3C capabilities merged into the session request. */
  capabilities?: Record<string, unknown>;
  /**
   * Open Web Inspector automatically when the session starts
   * (`safari:automaticInspection`).
   */
  automaticInspection?: boolean;
  /** Accept self-signed / invalid TLS certificates. */
  acceptInsecureCerts?: boolean;
  /** ms to wait for safaridriver to become ready. */
  timeout?: number;
  /**
   * Which automation channel drives pages.
   *
   * `'webdriver'` (the default) is the only one that works on a stable Safari.
   * `'mcp'` drives everything through `safaridriver --mcp`, which requires
   * Safari Technology Preview 247+ and gives up element handles, cookies,
   * frames, XPath, window geometry, and the low-level Actions API — in
   * exchange for `page.networkRequests()` working on the page you are driving.
   */
  backend?: BackendName;
}

export interface ConnectOptions {
  /** Base URL of an already-running safaridriver, e.g. http://127.0.0.1:4444. */
  driverUrl: string;
  /** Attach to this existing session instead of creating one. */
  sessionId?: string;
  defaultViewport?: Viewport | null;
  appName?: string;
  capabilities?: Record<string, unknown>;
  acceptInsecureCerts?: boolean;
}

/**
 * Launch Safari under automation and return a Puppeteer-style {@link Browser}.
 *
 * Prerequisites, one time per machine:
 *   safaridriver --enable
 * and in Safari: Develop > Allow Remote Automation.
 */
export async function launch(options: LaunchOptions = {}): Promise<Browser> {
  if (options.headless === true) {
    throw new UnsupportedOperationError(
      'launch({ headless: true })',
      'Safari has no headless mode; safaridriver always drives a visible window (SeleniumHQ/selenium#12046).',
      'Run headful, or move the window off-screen with page.setWindowRect({ x: -10000, y: 0 }).',
    );
  }

  const driverBinary = options.safaridriverPath ?? DEFAULT_SAFARIDRIVER;
  const backend = options.backend ?? 'webdriver';

  if (backend === 'mcp') {
    return launchMcpBackend(options, driverBinary);
  }

  const process = await SafariDriverProcess.start({
    binary: driverBinary,
    port: options.port,
    dumpio: options.dumpio,
    diagnose: options.diagnose,
    startTimeout: options.timeout,
  });

  const client = new WebDriverClient(process.url);

  const capabilities: Record<string, unknown> = {
    browserName: browserNameFor(driverBinary),
    ...(options.acceptInsecureCerts ? { acceptInsecureCerts: true } : {}),
    ...(options.automaticInspection ? { 'safari:automaticInspection': true } : {}),
    ...options.capabilities,
  };

  let created: { capabilities: Record<string, unknown> };
  try {
    created = await client.newSession(capabilities);
  } catch (cause) {
    await process.kill();
    throw new SafariDriverError(
      `Failed to create a Safari session: ${(cause as Error).message}\n\n${REMOTE_AUTOMATION_HINT}`,
    );
  }

  // We poll for everything ourselves, so implicit waits would only add
  // unpredictable latency on top.
  await client.setTimeouts({ implicit: 0 }).catch(() => {});

  const browser = new Browser({
    session: new WebDriverSession(client, process),
    safari: new SafariApp({ appName: options.appName }),
    defaultViewport: options.defaultViewport === undefined ? null : options.defaultViewport,
    capabilities: created.capabilities,
  });

  await browser.initialize();
  return browser;
}

/**
 * Launch with `safaridriver --mcp` as the only channel.
 *
 * No WebDriver session is created at all — that is the point. The MCP server
 * can only observe tabs it owns, so anything else would put the pages beyond
 * reach of `page.networkRequests()`.
 */
async function launchMcpBackend(options: LaunchOptions, driverBinary: string): Promise<Browser> {
  const { isMcpSupported, MCP_UNAVAILABLE_HINT, SafariMcp } = await import('./mcp/SafariMcp.ts');

  if (!(await isMcpSupported(driverBinary))) {
    throw new McpError(
      `${driverBinary} does not support --mcp, so backend: 'mcp' cannot work.\n\n${MCP_UNAVAILABLE_HINT}`,
    );
  }

  const mcp = await SafariMcp.start({ binary: driverBinary, dumpio: options.dumpio });
  const session = new McpSession(mcp);

  try {
    await session.initialize();
  } catch (cause) {
    await mcp.close().catch(() => {});
    throw new McpError(
      `Could not open a tab through the MCP server: ${(cause as Error).message}`,
    );
  }

  const browser = new Browser({
    session,
    safari: new SafariApp({ appName: options.appName }),
    defaultViewport: options.defaultViewport === undefined ? null : options.defaultViewport,
  });

  await browser.initialize();
  return browser;
}

/**
 * The `browserName` capability a given driver will accept.
 *
 * safaridriver matches this string against the browser it actually hosts and
 * rejects the session outright on a mismatch — Technology Preview's driver
 * reports `Safari Technology Preview`, not `safari`. Deriving it from the
 * binary path means `safaridriverPath` alone is enough to target the preview
 * build; callers can still override via `capabilities`.
 */
export function browserNameFor(driverBinary: string): string {
  return driverBinary.includes('Safari Technology Preview')
    ? 'Safari Technology Preview'
    : 'safari';
}


/**
 * Connect to a safaridriver you started yourself.
 *
 * Useful when you want the driver's lifetime to outlive your script, or when
 * running it on another machine / a device host.
 */
export async function connect(options: ConnectOptions): Promise<Browser> {
  const client = new WebDriverClient(options.driverUrl);

  let capabilities: Record<string, unknown> = {};
  if (options.sessionId) {
    await client.attachSession(options.sessionId).catch((cause: Error) => {
      throw new SafariDriverError(
        `Could not attach to safaridriver session "${options.sessionId}": ${cause.message}`,
      );
    });
  } else {
    const created = await client.newSession({
      browserName: 'safari',
      ...(options.acceptInsecureCerts ? { acceptInsecureCerts: true } : {}),
      ...options.capabilities,
    });
    capabilities = created.capabilities;
  }

  const browser = new Browser({
    session: new WebDriverSession(client, null),
    safari: new SafariApp({ appName: options.appName }),
    defaultViewport: options.defaultViewport === undefined ? null : options.defaultViewport,
    capabilities,
  });

  await browser.initialize();
  return browser;
}

export { Browser } from './api/Browser.ts';
export type { BackendFeature, BackendName, PageBackend, BrowserSession } from './backend/types.ts';
export { WebDriverBackend } from './backend/WebDriverBackend.ts';
export { McpBackend } from './backend/McpBackend.ts';
export { WebDriverSession, McpSession } from './backend/sessions.ts';
export { Page } from './api/Page.ts';
export type { Viewport, ScreenshotOptions, WaitForOptions, ConsoleMessage, Dialog, Cookie } from './api/Page.ts';
export { JSHandle, ElementHandle } from './api/JSHandle.ts';
export { Keyboard, Mouse, Touchscreen } from './api/Input.ts';
export { SafariApp } from './applescript/safari.ts';
export { runAppleScript, runJxa, runJxaJson } from './applescript/osascript.ts';
export { WebDriverClient } from './webdriver/client.ts';
export {
  SafariDriverProcess,
  DEFAULT_SAFARIDRIVER,
  TECH_PREVIEW_SAFARIDRIVER,
} from './webdriver/safaridriver.ts';
export {
  SafariMcp,
  isMcpSupported,
  findMcpCapableDriver,
  SAFARI_MCP_TOOLS,
  MCP_UNAVAILABLE_HINT,
  MCP_REMOTE_AUTOMATION_HINT,
} from './mcp/SafariMcp.ts';
export type { SafariMcpOptions, SafariMcpToolName } from './mcp/SafariMcp.ts';
export { McpTransport, textOf, jsonOf, PROTOCOL_VERSION } from './mcp/transport.ts';
export type { McpTool, McpToolResult, McpTransportOptions } from './mcp/transport.ts';
export {
  SafariPuppeteerError,
  TimeoutError,
  TargetCloseError,
  UnsupportedOperationError,
  WebDriverError,
  SafariDriverError,
  McpError,
} from './common/errors.ts';

export default { launch, connect };
