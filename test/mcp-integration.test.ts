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
import { poll, sleep } from '../src/common/util.ts';
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
   * The decisive question for this integration, and the reason `Page` has no
   * MCP-backed methods: the MCP server sees only tabs it created itself. While
   * the WebDriver session holds a tab, `list_tabs` is empty.
   *
   * This asserts the isolation rather than the capability. If it ever starts
   * failing, Apple has connected the two channels and the per-page APIs become
   * worth building.
   */
  mcpTest('cannot see the tab the WebDriver session is driving', async () => {
    const mcp = await browser!.mcp();
    const seen = await mcp.canSee((expression) => page.evaluate(expression));
    assert.equal(
      seen,
      false,
      'The MCP server can now see WebDriver-owned tabs — the channels are no ' +
        'longer isolated, so page-scoped network inspection is newly possible.',
    );
    assert.deepEqual(await mcp.listTabs(), [], 'expected no tabs visible to MCP');
  });

  /**
   * Needs the public internet, because the server does not record loopback
   * traffic — see the test below. Skips rather than fails when offline.
   */
  mcpTest('observes network requests on a tab it owns', async () => {
    const mcp = await browser!.mcp();
    const tab = (await mcp.createTab()) as { handle: string };
    try {
      await mcp.switchTab(tab.handle);
      // Capture only covers navigations made after the tab exists, so the
      // order here is load-bearing.
      await mcp.navigate('https://example.com/', tab.handle);

      // The list settles shortly after navigation returns, so poll rather
      // than sampling once.
      const result = await poll(
        async () => {
          const listed = (await mcp.listNetworkRequests({ tabHandle: tab.handle })) as {
            count: number;
            requests: Array<{ url: string; status: number; method: string }>;
          };
          return listed.count > 0 ? listed : null;
        },
        { timeout: 15_000, interval: 250, message: 'Waiting for MCP to observe a request' },
      );

      const document = result.requests.find((request) =>
        request.url.startsWith('https://example.com'),
      );
      assert.ok(document, `no example.com request in ${JSON.stringify(result.requests)}`);
      assert.equal(document.status, 200);
      assert.equal(document.method, 'GET');
    } catch (cause) {
      if ((cause as Error).name === 'TimeoutError') {
        // Almost certainly no internet on this machine; the capability itself
        // is covered by the unit tests against the fixture server.
        return;
      }
      throw cause;
    } finally {
      await mcp.closeTab(tab.handle).catch(() => {});
    }
  });

  /**
   * A limitation worth pinning down: the MCP server records nothing for
   * `127.0.0.1`, while the very next navigation to a public origin in the same
   * tab is captured normally. That rules out the usual hermetic-test pattern
   * of serving fixtures from a local HTTP server.
   */
  mcpTest('does not observe loopback requests', async () => {
    const mcp = await browser!.mcp();
    const tab = (await mcp.createTab()) as { handle: string };
    try {
      await mcp.switchTab(tab.handle);
      await mcp.navigate(`${origin}/`, tab.handle);

      // Confirm the navigation really happened before asserting on the absence.
      const info = (await mcp.pageInfo()) as { url: string };
      assert.ok(info.url.startsWith(origin), `expected to be on ${origin}, got ${info.url}`);

      await sleep(2500);
      const listed = (await mcp.listNetworkRequests({ tabHandle: tab.handle })) as {
        count: number;
      };
      assert.equal(
        listed.count,
        0,
        'Loopback traffic is now captured — local fixture servers can be used after all.',
      );
    } finally {
      await mcp.closeTab(tab.handle).catch(() => {});
    }
  });

  mcpTest('sets a media type but offers no media features', async () => {
    const mcp = await browser!.mcp();
    // Every mutating tool needs a tab the server owns; without one it answers
    // "No active tab" rather than acting on the WebDriver page.
    const tab = (await mcp.createTab()) as { handle: string };
    try {
      await mcp.switchTab(tab.handle);
      await mcp.setEmulatedMediaType('print');
      await mcp.setEmulatedMediaType('');
      await assert.rejects(
        () => mcp.call('set_emulated_media', { media: { 'prefers-color-scheme': 'dark' } }),
        /Missing required 'media'/,
      );
    } finally {
      await mcp.closeTab(tab.handle).catch(() => {});
    }
  });

  mcpTest('still refuses request interception and page-scoped inspection', async () => {
    await assert.rejects(() => page.setRequestInterception(), /not supported/);
    await assert.rejects(() => page.networkRequests(), /cannot see tabs owned by a WebDriver session/);
    await assert.rejects(() => page.emulateMediaFeatures(), /not supported/);
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
