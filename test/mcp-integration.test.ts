/**
 * MCP integration tests — these drive a real Safari Technology Preview.
 *
 * Requires STP 247+ with remote automation enabled *in Technology Preview*
 * (its settings are separate from Safari's):
 *
 *   brew install --cask safari-technology-preview
 *   "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" --enable
 *
 * Skips with an explanation rather than failing when that is not set up, so the
 * suite stays useful on machines and CI runners without a preview build.
 *
 * Run: npm run test:mcp:integration
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { launch } from '../src/index.ts';
import type { Browser } from '../src/api/Browser.ts';
import type { Page } from '../src/api/Page.ts';
import { isScreenLocked } from '../src/common/macos.ts';
import { isMcpSupported, SafariMcp } from '../src/mcp/SafariMcp.ts';
import { TECH_PREVIEW_SAFARIDRIVER } from '../src/webdriver/safaridriver.ts';

const FIXTURE = `<!doctype html>
<meta charset="utf-8">
<title>MCP Fixture</title>
<h1 id="heading">Hello MCP</h1>
<script src="/app.js"></script>
<script>console.log('fixture-console-marker');</script>`;

let server: Server;
let origin: string;
let browser: Browser | null = null;
let page: Page;
let skipReason: string | null = null;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('globalThis.__loaded = true;');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  if (!(await isMcpSupported(TECH_PREVIEW_SAFARIDRIVER))) {
    skipReason =
      'No safaridriver with --mcp. Install Safari Technology Preview 247+:\n' +
      '  brew install --cask safari-technology-preview';
    return;
  }

  try {
    browser = await launch({
      mcp: true,
      safaridriverPath: TECH_PREVIEW_SAFARIDRIVER,
      defaultViewport: { width: 1024, height: 768 },
    });
    const [first] = await browser.pages();
    if (!first) throw new Error('No page was opened.');
    page = first;
    await page.goto(origin, { waitUntil: 'load' });
  } catch (cause) {
    skipReason =
      `Could not drive Safari Technology Preview: ${(cause as Error).message}\n` +
      'Remote automation must be enabled in Technology Preview separately from Safari:\n' +
      `  "${TECH_PREVIEW_SAFARIDRIVER}" --enable\n` +
      '  then STP > Settings > Developer > "Allow remote automation and external agents"';
    await browser?.close().catch(() => {});
    browser = null;
  }
});

after(async () => {
  await browser?.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Run only when a real MCP-capable Safari is available. */
function mcpTest(name: string, fn: () => Promise<void>): void {
  it(name, async (t) => {
    if (skipReason !== null) {
      t.skip(skipReason);
      return;
    }
    await fn();
  });
}

describe('MCP channel against real Safari', () => {
  mcpTest('advertises the documented tool set', async () => {
    const mcp = await browser!.mcp();
    assert.ok(mcp.tools.length >= 15, `expected 15+ tools, got ${mcp.tools.length}`);
    for (const required of ['list_network_requests', 'get_network_request', 'set_emulated_media']) {
      assert.ok(mcp.has(required), `missing tool: ${required}`);
    }
  });

  mcpTest('reuses one server across calls', async () => {
    const first = await browser!.mcp();
    const second = await browser!.mcp();
    assert.equal(first, second);
  });

  /**
   * The decisive question for this integration: the MCP server manages its own
   * tabs, and nothing documents whether it can observe a tab that a WebDriver
   * session owns. If this fails, `page.networkRequests()` is reporting on a
   * different page than the one you navigated.
   */
  mcpTest('can observe the tab the WebDriver session is driving', async () => {
    const mcp = await browser!.mcp();
    const seen = await mcp.canSee((expression) => page.evaluate(expression));
    assert.ok(
      seen,
      'The MCP server could not see the WebDriver-controlled tab, so per-page ' +
        'MCP observation is reporting on a different page.',
    );
  });

  mcpTest('observes network requests for the loaded page', async () => {
    const requests = JSON.stringify(await page.networkRequests());
    assert.match(requests, /app\.js/, 'expected the subresource request to be observed');
  });

  mcpTest('emulates prefers-color-scheme, which WebDriver cannot', async () => {
    await page.emulateMediaFeatures({ 'prefers-color-scheme': 'dark' });
    const isDark = await page.evaluate<boolean>(
      () => matchMedia('(prefers-color-scheme: dark)').matches,
    );
    assert.equal(isDark, true);
    await page.emulateMediaFeatures({ 'prefers-color-scheme': 'light' });
  });

  mcpTest('captures console messages without an in-page hook', async () => {
    const mcp = await browser!.mcp();
    const messages = JSON.stringify(await mcp.consoleMessages({ limit: 50 }));
    assert.match(messages, /fixture-console-marker/);
  });

  mcpTest('still refuses request interception', async () => {
    await assert.rejects(() => page.setRequestInterception(), /not supported/);
  });
});

describe('MCP availability reporting', () => {
  it('detects whether the stable driver supports --mcp', async () => {
    // Not an assertion about the answer — just that probing never throws, since
    // launch() depends on it to fail fast with instructions.
    assert.equal(typeof (await isMcpSupported('/usr/bin/safaridriver')), 'boolean');
  });

  it('explains how to install when no driver supports --mcp', async () => {
    await assert.rejects(
      () => SafariMcp.start({ binary: '/nonexistent/safaridriver' }),
      /does not support --mcp|safari-technology-preview/,
    );
  });

  it('notes the screen lock state, which affects MCP interactions too', async () => {
    // page_interactions dispatches native events, so it has the same
    // locked-screen failure mode as WebDriver clicks.
    assert.equal(typeof (await isScreenLocked()), 'boolean');
  });
});
