/**
 * The `safaridriver --mcp` server, wrapped as a typed client.
 *
 * Apple shipped this in Safari Technology Preview 247 / Safari 27 beta. It is a
 * *separate* automation channel from the WebDriver session this library
 * normally drives — and, measured on Technology Preview 249, a separate
 * browsing context as well: it sees only tabs it created itself. While a
 * WebDriver session holds a tab, `list_tabs` returns `[]` and `page_info`
 * answers "No active tab". {@link SafariMcp.canSee} checks this empirically so
 * the assumption is never silent.
 *
 * What it adds over classic WebDriver is read-only *observation* of its own
 * tabs: network requests in useful detail (method, status, MIME type, size,
 * timing, initiator). It cannot intercept or modify requests — that needs
 * WebDriver BiDi's `network` module, which Safari does not implement yet.
 *
 * Its element model is also different: nodes are addressed by UID from
 * {@link SafariMcp.pageContent}, not by CSS selector or element reference.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { McpError } from '../common/errors.ts';
import { DEFAULT_SAFARIDRIVER, TECH_PREVIEW_SAFARIDRIVER } from '../webdriver/safaridriver.ts';
import { McpTransport, jsonOf, textOf, type McpTool, type McpToolResult } from './transport.ts';

const execFileAsync = promisify(execFile);

/** Tools Apple documents for the Safari MCP server. */
export const SAFARI_MCP_TOOLS = [
  'browser_console_messages',
  'browser_dialogs',
  'close_tab',
  'create_tab',
  'evaluate_javascript',
  'get_network_request',
  'get_page_content',
  'list_network_requests',
  'list_tabs',
  'navigate_to_url',
  'page_info',
  'page_interactions',
  'screenshot',
  'set_emulated_media',
  'set_viewport_size',
  'switch_tab',
  'wait_for_navigation',
] as const;

export type SafariMcpToolName = (typeof SAFARI_MCP_TOOLS)[number];

export const MCP_UNAVAILABLE_HINT =
  'The MCP server is only in Safari Technology Preview 247+ / Safari 27 beta.\n\n' +
  'To install:\n' +
  '  brew install --cask safari-technology-preview\n\n' +
  'Then, in Safari Technology Preview (its settings are separate from Safari):\n' +
  '  1. Settings > Advanced > check "Show features for web developers"\n' +
  '  2. Settings > Developer > check "Allow remote automation and external agents"\n\n' +
  'Then point safari-puppeteer at its driver:\n' +
  `  launch({ mcp: true, safaridriverPath: '${TECH_PREVIEW_SAFARIDRIVER}' })`;

export interface SafariMcpOptions {
  /** safaridriver binary to run with `--mcp`. */
  binary?: string;
  /** ms per request. */
  timeout?: number;
  /** Pipe the server's stderr through. */
  dumpio?: boolean;
  /** Override the spawn arguments. Defaults to `['--mcp']`. */
  args?: string[];
}

/**
 * Whether a given safaridriver supports `--mcp`.
 *
 * Checked by parsing `--help` rather than by running `--mcp` and seeing what
 * happens, so it costs nothing and starts no browser.
 */
export async function isMcpSupported(binary: string = DEFAULT_SAFARIDRIVER): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ['--help'], { timeout: 10_000 });
    return `${stdout}${stderr}`.includes('--mcp');
  } catch (cause) {
    // `--help` exits non-zero on some builds; the output is still on the error.
    const output = `${(cause as { stdout?: string }).stdout ?? ''}${(cause as { stderr?: string }).stderr ?? ''}`;
    return output.includes('--mcp');
  }
}

/**
 * Find a safaridriver that supports `--mcp`, preferring the stable one.
 * Returns `null` if neither does.
 */
export async function findMcpCapableDriver(): Promise<string | null> {
  for (const binary of [DEFAULT_SAFARIDRIVER, TECH_PREVIEW_SAFARIDRIVER]) {
    if (await isMcpSupported(binary)) return binary;
  }
  return null;
}

export class SafariMcp {
  #transport: McpTransport;
  #tools: McpTool[] = [];
  #serverInfo: unknown = null;
  #binary: string;

  private constructor(transport: McpTransport, binary: string) {
    this.#transport = transport;
    this.#binary = binary;
  }

  /**
   * Start the MCP server.
   *
   * If no binary is given, the stable driver is tried first and Technology
   * Preview second, so this works on both without the caller branching.
   */
  static async start(options: SafariMcpOptions = {}): Promise<SafariMcp> {
    const binary = options.binary ?? (await findMcpCapableDriver());
    if (binary === null) {
      throw new McpError(
        `No safaridriver on this machine supports --mcp.\n\n${MCP_UNAVAILABLE_HINT}`,
      );
    }
    if (!(await isMcpSupported(binary))) {
      throw new McpError(
        `${binary} does not support --mcp.\n\n${MCP_UNAVAILABLE_HINT}`,
      );
    }

    const transport = new McpTransport({
      binary,
      args: options.args,
      timeout: options.timeout,
      dumpio: options.dumpio,
    });
    const { serverInfo } = await transport.start();

    const instance = new SafariMcp(transport, binary);
    instance.#serverInfo = serverInfo;
    instance.#tools = await transport.listTools();
    return instance;
  }

  /** Path of the driver backing this server. */
  get binary(): string {
    return this.#binary;
  }

  /** `serverInfo` from the MCP handshake. */
  get serverInfo(): unknown {
    return this.#serverInfo;
  }

  /** Tools the server actually advertised, which may differ from the docs. */
  get tools(): McpTool[] {
    return this.#tools;
  }

  /** Whether a named tool is available on this server build. */
  has(tool: string): boolean {
    return this.#tools.some((candidate) => candidate.name === tool);
  }

  /**
   * Raw tool call. The typed helpers below cover the documented tools, but
   * argument names are Apple's and may shift between previews, so this stays
   * public as an escape hatch.
   */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (this.#tools.length > 0 && !this.has(tool)) {
      throw new McpError(
        `The Safari MCP server does not expose a "${tool}" tool.\n` +
          `Available: ${this.#tools.map((candidate) => candidate.name).join(', ')}`,
        { tool },
      );
    }
    try {
      return await this.#transport.callTool(tool, args);
    } catch (cause) {
      throw enrich(cause as Error, tool, this.#binary);
    }
  }

  /** Tool call, parsed as JSON when the server answers with JSON. */
  async callJson(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return jsonOf(await this.call(tool, args));
  }

  /** Tool call, flattened to its text content. */
  async callText(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    return textOf(await this.call(tool, args));
  }

  // --- Observation: the reason this integration exists -----------------------

  /**
   * Network requests the server has observed.
   *
   * This is the capability classic WebDriver has no equivalent for. It is
   * read-only: there is no interception, blocking, or modification.
   *
   * **Recording has to be started before the traffic happens.** The first call
   * to this tool arms the capture for that tab and returns an empty list; only
   * navigations after that are recorded. Call it once, then navigate, then
   * call it again — {@link SafariMcp.startNetworkCapture} exists to make that
   * first call read as intent rather than as a discarded result.
   *
   * `clear` empties the buffer after reading, which is how you scope a
   * capture to one navigation.
   */
  async listNetworkRequests(
    options: { filter?: string; since?: unknown; clear?: boolean; tabHandle?: string } = {},
  ): Promise<unknown> {
    return this.callJson('list_network_requests', {
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.clear === undefined ? {} : { clear: options.clear }),
      ...(options.tabHandle === undefined ? {} : { tab_handle: options.tabHandle }),
    });
  }

  /**
   * Begin recording network activity for a tab.
   *
   * Arming is what the first `list_network_requests` call does implicitly;
   * naming it keeps the ordering requirement visible at the call site.
   */
  async startNetworkCapture(tabHandle?: string): Promise<void> {
    await this.listNetworkRequests(tabHandle === undefined ? {} : { tabHandle });
  }

  /** Detail for a single observed request, including headers and body. */
  async getNetworkRequest(requestId: string | number): Promise<unknown> {
    return this.callJson('get_network_request', { request_id: requestId });
  }

  /** Console messages the server has collected. */
  async consoleMessages(
    options: { limit?: number; levelFilter?: string; clear?: boolean; tabHandle?: string } = {},
  ): Promise<unknown> {
    return this.callJson('browser_console_messages', {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.levelFilter === undefined ? {} : { level_filter: options.levelFilter }),
      ...(options.clear === undefined ? {} : { clear: options.clear }),
      ...(options.tabHandle === undefined ? {} : { tab_handle: options.tabHandle }),
    });
  }

  /** Act on an open JavaScript dialog. `action` is required by the server. */
  async dialog(action: string, inputText?: string): Promise<unknown> {
    return this.callJson('browser_dialogs', {
      action,
      ...(inputText === undefined ? {} : { inputText }),
    });
  }

  /** Tabs the MCP server can see. */
  async listTabs(): Promise<unknown> {
    return this.callJson('list_tabs', {});
  }

  /** Metadata about the active tab. */
  async pageInfo(): Promise<unknown> {
    return this.callJson('page_info', {});
  }

  /**
   * Serialized content of the active tab. The server supports a rich set of
   * options (accessibility attributes, event listeners, rects, subframes);
   * they are passed through untouched.
   */
  async pageContent(options: Record<string, unknown> = {}): Promise<string> {
    return this.callText('get_page_content', options);
  }

  /**
   * Evaluate an expression in the MCP server's active tab and return its value.
   *
   * The tool treats its input as a *function body*, not an expression: bare
   * `1+1` evaluates and discards, answering `null`. That is a genuinely easy
   * mistake to make, so this wraps the input in an explicit `return` and
   * {@link SafariMcp.evaluateBody} takes raw bodies for multi-statement code.
   *
   * `frameId` is a UID from {@link SafariMcp.pageContent}, not a WebDriver
   * frame reference.
   */
  async evaluate(expression: string, frameId?: string): Promise<unknown> {
    return this.evaluateBody(`return (${expression});`, frameId);
  }

  /**
   * Evaluate a function body verbatim — use when you need statements, or the
   * server's `$uid(N)` macros for referring to nodes from `pageContent()`.
   */
  async evaluateBody(body: string, frameId?: string): Promise<unknown> {
    return this.callJson('evaluate_javascript', {
      expression: body,
      ...(frameId === undefined ? {} : { frameId }),
    });
  }

  /**
   * Emulate a CSS media *type* — `'screen'`, `'print'`, or `''` to clear.
   *
   * This is Puppeteer's `emulateMediaType()`, not `emulateMediaFeatures()`:
   * the server takes a plain string and has no way to set features like
   * `prefers-color-scheme`. Passing an object fails with
   * `Invalid arguments: Missing required 'media'`.
   */
  async setEmulatedMediaType(media: string): Promise<void> {
    await this.call('set_emulated_media', { media });
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    await this.call('set_viewport_size', { width, height });
  }

  async createTab(url?: string): Promise<unknown> {
    return this.callJson('create_tab', url === undefined ? {} : { url });
  }

  async switchTab(handle: string): Promise<void> {
    await this.call('switch_tab', { handle });
  }

  async closeTab(handle: string): Promise<void> {
    await this.call('close_tab', { handle });
  }

  async navigate(url: string, handle?: string): Promise<void> {
    await this.call('navigate_to_url', {
      url,
      ...(handle === undefined ? {} : { handle }),
    });
  }

  async waitForNavigation(timeoutSeconds?: number): Promise<void> {
    await this.call(
      'wait_for_navigation',
      timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds },
    );
  }

  /** Drive the documented interaction batch (click, type, scroll, hover). */
  async interact(interactions: unknown[], fullText?: boolean): Promise<unknown> {
    return this.callJson('page_interactions', {
      interactions,
      ...(fullText === undefined ? {} : { fullText }),
    });
  }

  /**
   * PNG screenshot of the MCP server's active tab, base64-encoded.
   *
   * `full_page` here is native rather than emulated by resizing the window.
   *
   * The tool does not return image bytes: it writes a PNG to disk and answers
   * with prose naming the file. Rather than parse that sentence, we hand it an
   * explicit `savePath`, read the file, and clean up — so callers still get
   * base64 like every other screenshot path in this library.
   */
  async screenshot(options: { fullPage?: boolean; node?: unknown; savePath?: string } = {}): Promise<string> {
    const target = options.savePath ?? join(tmpdir(), `safari-puppeteer-${randomUUID()}.png`);

    const result = await this.call('screenshot', {
      ...(options.fullPage === undefined ? {} : { full_page: options.fullPage }),
      ...(options.node === undefined ? {} : { node: options.node }),
      savePath: target,
    });

    // Newer builds may return the image inline; prefer that when present.
    const image = result.content?.find((part) => part.type === 'image');
    if (image && typeof image['data'] === 'string') return image['data'];

    try {
      return (await readFile(target)).toString('base64');
    } catch (cause) {
      throw new McpError(
        `The screenshot tool reported "${textOf(result)}" but ${target} could not be read: ` +
          `${(cause as Error).message}`,
        { tool: 'screenshot' },
      );
    } finally {
      // Only our own temp file is ours to remove.
      if (options.savePath === undefined) await unlink(target).catch(() => {});
    }
  }

  // --- The decisive question -------------------------------------------------

  /**
   * Whether this MCP server can observe the tab a WebDriver session is driving.
   *
   * The two channels are independent, and nothing in Apple's documentation says
   * whether they share a view of the browser. Rather than assume, this stamps a
   * one-off marker into the WebDriver-controlled page and looks for it in the
   * MCP server's own tab listing.
   *
   * The marker is written to `document.title`, and the original title is
   * restored afterwards. Searching the raw listing text keeps this robust to
   * the exact shape of `list_tabs`, which is not specified.
   *
   * @param evaluateInWebDriverTab Runs an expression in the WebDriver tab —
   *        pass `page.evaluate.bind(page)`.
   */
  async canSee(
    evaluateInWebDriverTab: (fn: string) => Promise<unknown>,
  ): Promise<boolean> {
    const marker = `safari-puppeteer-probe-${probeCounter()}`;

    const original = (await evaluateInWebDriverTab(
      `(() => { const t = document.title; document.title = ${JSON.stringify(marker)}; return t; })()`,
    )) as string;

    try {
      const tabs = await this.call('list_tabs', {});
      return JSON.stringify(tabs).includes(marker);
    } finally {
      await evaluateInWebDriverTab(
        `(() => { document.title = ${JSON.stringify(original ?? '')}; })()`,
      ).catch(() => {
        // Restoring the title is a courtesy; never let it mask the result.
      });
    }
  }

  /** Stop the server. */
  async close(): Promise<void> {
    await this.#transport.stop();
  }
}

/**
 * Monotonic suffix for probe markers.
 *
 * Deliberately not `Math.random()`/`Date.now()` — a counter is enough to keep
 * concurrent probes distinct within a process and keeps the value reproducible.
 */
let probes = 0;
function probeCounter(): number {
  return ++probes;
}

/**
 * Setup hint for the toggle the MCP server needs.
 *
 * The server is itself backed by WebDriver internally, so it requires the same
 * Safari permission — but it only discovers that on the first tool call that
 * touches the browser. `initialize` and `tools/list` succeed regardless, which
 * makes the failure look like a tool bug rather than a setup step.
 */
export const MCP_REMOTE_AUTOMATION_HINT =
  'The Safari MCP server needs remote automation enabled, in the *same app* whose\n' +
  'driver you are running. Note this is per-app: enabling it in Safari does nothing\n' +
  'for Safari Technology Preview.\n\n' +
  'To fix, run once (it prompts for your password):\n' +
  `  "${TECH_PREVIEW_SAFARIDRIVER}" --enable\n\n` +
  'Then in Safari Technology Preview:\n' +
  '  1. Settings > Advanced > check "Show features for web developers"\n' +
  '  2. Settings > Developer > check "Allow remote automation and external agents"';

/** Attach an actionable remedy to known MCP tool failures. */
function enrich(error: Error, tool: string, binary: string): Error {
  const message = error.message.toLowerCase();
  if (message.includes('allow remote automation') || message.includes('remote automation')) {
    return new McpError(
      `MCP tool "${tool}" could not control ${binary}.\n\n${MCP_REMOTE_AUTOMATION_HINT}\n\n` +
        `Server said: ${error.message}`,
      { tool },
    );
  }
  return error;
}
