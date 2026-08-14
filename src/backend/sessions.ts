/**
 * Browser-level session adapters.
 *
 * `Browser` owns tab bookkeeping, viewport defaults, and lifecycle; these
 * supply the handful of calls underneath that are protocol-specific.
 */
import { McpBackend } from './McpBackend.ts';
import type { BackendName, BrowserSession, PageBackend } from './types.ts';
import { WebDriverBackend } from './WebDriverBackend.ts';
import type { SafariMcp } from '../mcp/SafariMcp.ts';
import type { WebDriverClient } from '../webdriver/client.ts';
import type { SafariDriverProcess } from '../webdriver/safaridriver.ts';

export class WebDriverSession implements BrowserSession {
  readonly name: BackendName = 'webdriver';

  #client: WebDriverClient;
  #process: SafariDriverProcess | null;

  constructor(client: WebDriverClient, process: SafariDriverProcess | null) {
    this.#client = client;
    this.#process = process;
  }

  get client(): WebDriverClient {
    return this.#client;
  }

  listHandles(): Promise<string[]> {
    return this.#client.getWindowHandles();
  }

  currentHandle(): Promise<string> {
    return this.#client.getWindowHandle();
  }

  async newTab(): Promise<string> {
    const { handle } = await this.#client.newWindow('tab');
    await this.#client.switchToWindow(handle);
    return handle;
  }

  createBackend(handle: string): PageBackend {
    return new WebDriverBackend(this.#client, handle);
  }

  async dispose(): Promise<void> {
    await this.#client.deleteSession().catch(() => {});
    await this.#process?.kill();
  }
}

/**
 * A session backed entirely by `safaridriver --mcp`.
 *
 * The server starts with no tabs of its own, so {@link McpSession.initialize}
 * opens the first one — without it `list_tabs` is empty and there is nothing to
 * drive.
 */
export class McpSession implements BrowserSession {
  readonly name: BackendName = 'mcp';

  #mcp: SafariMcp;

  constructor(mcp: SafariMcp) {
    this.#mcp = mcp;
  }

  get mcp(): SafariMcp {
    return this.#mcp;
  }

  /** Open the initial tab and return its handle. */
  async initialize(): Promise<string> {
    const existing = await this.listHandles();
    if (existing.length > 0) return existing[0]!;
    return this.newTab();
  }

  async listHandles(): Promise<string[]> {
    const raw = await this.#mcp.listTabs();
    const tabs = Array.isArray(raw) ? raw : ((raw as { tabs?: unknown[] })?.tabs ?? []);
    return tabs
      .map((tab) => (tab as { handle?: string }).handle)
      .filter((handle): handle is string => typeof handle === 'string');
  }

  async currentHandle(): Promise<string> {
    const [first] = await this.listHandles();
    if (first === undefined) return this.newTab();
    return first;
  }

  async newTab(): Promise<string> {
    const created = (await this.#mcp.createTab()) as { handle?: string };
    if (typeof created?.handle !== 'string') {
      throw new Error(`create_tab did not return a handle: ${JSON.stringify(created)}`);
    }
    await this.#mcp.switchTab(created.handle);
    return created.handle;
  }

  createBackend(handle: string): PageBackend {
    return new McpBackend(this.#mcp, handle);
  }

  /**
   * Close the tabs we opened before stopping the server.
   *
   * Stopping the transport does not close them: the MCP server exits and the
   * browser it launched keeps running with the tabs still open.
   */
  async dispose(): Promise<void> {
    for (const handle of await this.listHandles().catch(() => [])) {
      await this.#mcp.closeTab(handle).catch(() => {});
    }
    await this.#mcp.close().catch(() => {});
  }
}
