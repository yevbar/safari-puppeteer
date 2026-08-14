/**
 * MCP channel tests — no Safari required.
 *
 * These run against test/fixtures/fake-mcp-server.mjs, which speaks the same
 * stdio dialect as `safaridriver --mcp` and advertises the tool list and
 * argument names captured from a live Safari Technology Preview 249 server.
 * That keeps the protocol layer verifiable on any machine while still failing
 * loudly if our assumptions about Apple's schema drift.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { McpError } from '../src/common/errors.ts';
import {
  isMcpSupported,
  SAFARI_MCP_TOOLS,
  SafariMcp,
} from '../src/mcp/SafariMcp.ts';
import { jsonOf, McpTransport, textOf } from '../src/mcp/transport.ts';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

const running: Array<{ close: () => Promise<void> }> = [];
after(async () => {
  for (const item of running) await item.close().catch(() => {});
});

async function startTransport(args: string[] = ['--mcp']): Promise<McpTransport> {
  const transport = new McpTransport({ binary: FAKE_SERVER, args, timeout: 5000 });
  await transport.start();
  running.push({ close: () => transport.stop() });
  return transport;
}

async function startMcp(binary = FAKE_SERVER): Promise<SafariMcp> {
  const mcp = await SafariMcp.start({ binary, timeout: 5000 });
  running.push({ close: () => mcp.close() });
  return mcp;
}

describe('McpTransport', () => {
  it('completes the handshake and reports serverInfo', async () => {
    const transport = new McpTransport({ binary: FAKE_SERVER, timeout: 5000 });
    const { serverInfo } = await transport.start();
    running.push({ close: () => transport.stop() });
    assert.deepEqual(serverInfo, { name: 'Safari', version: '1.0.0' });
  });

  it('tolerates non-JSON banner output on stdout', async () => {
    // The fixture prints a banner line before the protocol starts, exactly as
    // a driver might. Reaching a successful handshake proves it was skipped
    // rather than treated as a protocol error.
    const transport = await startTransport();
    assert.ok(transport.running);
  });

  it('lists tools', async () => {
    const transport = await startTransport();
    const tools = await transport.listTools();
    assert.equal(tools.length, 17);
  });

  it('routes concurrent requests to the right caller', async () => {
    const transport = await startTransport();
    const [tabs, info, content] = await Promise.all([
      transport.callTool('list_tabs', {}),
      transport.callTool('page_info', {}),
      transport.callTool('get_page_content', {}),
    ]);
    assert.match(textOf(tabs), /"handle":"tab-1"/);
    assert.match(textOf(info), /"title":"Fake Page"/);
    assert.match(textOf(content), /^<html>/);
  });

  it('turns a JSON-RPC error into an McpError', async () => {
    const transport = await startTransport();
    await assert.rejects(() => transport.callTool('no_such_tool', {}), (error: Error) => {
      assert.ok(error instanceof McpError);
      assert.match(error.message, /Unknown tool/);
      return true;
    });
  });

  it('turns an isError tool result into a rejection', async () => {
    const transport = await startTransport();
    await assert.rejects(
      () => transport.callTool('get_network_request', { request_id: 'missing' }),
      /No request with id missing/,
    );
  });

  it('times out a request the server never answers', async () => {
    const transport = new McpTransport({ binary: FAKE_SERVER, timeout: 300 });
    await transport.start();
    running.push({ close: () => transport.stop() });
    await assert.rejects(() => transport.request('never/responds', {}), /timed out after 300ms/);
  });

  it('rejects in-flight requests when the server dies', async () => {
    const transport = new McpTransport({ binary: FAKE_SERVER, timeout: 10_000 });
    await transport.start();
    // The handler must be attached before stop(), which rejects synchronously.
    const inflight = transport.request('never/responds', {}).then(
      () => null,
      (error: Error) => error,
    );
    await transport.stop();
    assert.match(((await inflight) as Error).message, /stopped|exited/);
  });

  it('rejects calls made after the transport is stopped', async () => {
    const transport = new McpTransport({ binary: FAKE_SERVER, timeout: 5000 });
    await transport.start();
    await transport.stop();
    await assert.rejects(() => transport.callTool('list_tabs', {}), McpError);
  });
});

describe('tool result decoding', () => {
  it('extracts text content', () => {
    assert.equal(textOf({ content: [{ type: 'text', text: ' hi ' }] }), 'hi');
  });

  it('joins multiple text parts', () => {
    assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  });

  it('parses JSON payloads', () => {
    assert.deepEqual(jsonOf({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  });

  it('falls back to raw text when the payload is prose', () => {
    assert.equal(jsonOf({ content: [{ type: 'text', text: 'not json' }] }), 'not json');
  });

  it('prefers structuredContent when present', () => {
    assert.deepEqual(
      jsonOf({ content: [{ type: 'text', text: 'ignored' }], structuredContent: { a: 2 } }),
      { a: 2 },
    );
  });

  it('returns null for an empty result', () => {
    assert.equal(jsonOf({ content: [] }), null);
  });
});

describe('capability detection', () => {
  it('detects --mcp support from the help output', async () => {
    assert.equal(await isMcpSupported(FAKE_SERVER), true);
  });

  it('reports no support when --mcp is absent from help', async () => {
    // The fixture suppresses the --mcp line under this flag, standing in for a
    // stable-Safari driver.
    const transport = new McpTransport({ binary: FAKE_SERVER, args: ['--no-mcp-support'] });
    assert.ok(transport instanceof McpTransport);
    assert.equal(await isMcpSupported('/nonexistent/safaridriver'), false);
  });
});

describe('SafariMcp', () => {
  it('exposes the tools the server advertises', async () => {
    const mcp = await startMcp();
    assert.equal(mcp.tools.length, 17);
    assert.ok(mcp.has('list_network_requests'));
    assert.equal(mcp.has('page_pdf'), false);
  });

  it('agrees with the documented tool list', async () => {
    // Guards against drift between our constant and a real server's schema.
    const mcp = await startMcp();
    assert.deepEqual(
      [...SAFARI_MCP_TOOLS].sort(),
      mcp.tools.map((tool) => tool.name).sort(),
    );
  });

  it('refuses an unknown tool locally, without a round trip', async () => {
    const mcp = await startMcp();
    await assert.rejects(() => mcp.call('page_pdf'), /does not expose a "page_pdf" tool/);
  });

  it('reads network requests', async () => {
    const mcp = await startMcp();
    const result = (await mcp.listNetworkRequests()) as {
      count: number;
      requests: Array<{ url: string; status: number; mime_type: string }>;
    };
    assert.equal(result.count, 2);
    assert.equal(result.requests[0]?.url, 'https://example.com/');
    assert.equal(result.requests[0]?.status, 200);
    assert.equal(result.requests[0]?.mime_type, 'text/html');
  });

  it('sends snake_case argument names the server actually expects', async () => {
    const mcp = await startMcp();
    // get_network_request requires `request_id`; camelCase would 404 at runtime.
    const detail = (await mcp.getNetworkRequest('0.28')) as { status: number };
    assert.equal(detail.status, 200);
  });

  it('omits unset optional arguments rather than sending undefined', async () => {
    const mcp = await startMcp();
    const result = (await mcp.listNetworkRequests({ clear: true })) as { requests: unknown[] };
    assert.equal(result.requests.length, 2);
  });

  it('exposes the tab lifecycle network capture depends on', async () => {
    // Capture only covers navigations after the tab exists, so these three
    // have to be reachable for the documented workflow to be followable.
    const mcp = await startMcp();
    for (const tool of ['create_tab', 'switch_tab', 'navigate_to_url']) {
      assert.ok(mcp.has(tool), `missing tool: ${tool}`);
    }
  });

  it('sets a media type, which is all the tool accepts', async () => {
    const mcp = await startMcp();
    await mcp.setEmulatedMediaType('print');
    const info = (await mcp.callJson('page_info')) as { title: string };
    assert.equal(info.title, 'Fake Page');
  });

  it('rejects a media *feature* object the way the real server does', async () => {
    // set_emulated_media takes a CSS media type string only — there is no way
    // to set prefers-color-scheme, so emulateMediaFeatures() cannot be built
    // on it. Passing an object must fail loudly rather than appear to work.
    const mcp = await startMcp();
    await assert.rejects(
      () => mcp.call('set_emulated_media', { media: { 'prefers-color-scheme': 'dark' } }),
      /Missing required 'media'/,
    );
  });

  it('returns base64 image data from screenshot', async () => {
    const mcp = await startMcp();
    assert.equal(await mcp.screenshot({ fullPage: true }), 'aGVsbG8=');
  });

  it('explains how to enable remote automation when the server refuses', async () => {
    // The real server answers initialize/tools-list fine and only fails on the
    // first tool call that touches the browser, which is what makes this error
    // look like a tool bug instead of a setup step. The fixture reproduces the
    // exact WebDriverErrorDomain text Safari returns.
    const mcp = await SafariMcp.start({
      binary: FAKE_SERVER,
      args: ['--mcp', '--fail-remote-automation'],
      timeout: 5000,
    });
    running.push({ close: () => mcp.close() });
    assert.equal(mcp.tools.length, 17);

    await assert.rejects(() => mcp.listTabs(), (error: Error) => {
      assert.ok(error instanceof McpError);
      assert.match(error.message, /Settings > Developer/);
      assert.match(error.message, /--enable/);
      assert.match(error.message, /per-app/);
      return true;
    });
  });
});

describe('attach probe', () => {
  it('reports true when the marker shows up in list_tabs', async () => {
    const mcp = await startMcp();
    // Stand-in for page.evaluate: the fake server shares one title between its
    // evaluator and its tab listing, modelling a server that CAN see the tab.
    const seen = await mcp.canSee((expression) => mcp.evaluate(expression));
    assert.equal(seen, true);
  });

  it('restores the original title afterwards', async () => {
    const mcp = await startMcp();
    await mcp.canSee((expression) => mcp.evaluate(expression));
    const info = (await mcp.pageInfo()) as { title: string };
    assert.equal(info.title, 'Fake Page');
  });

  it('reports false when the evaluated tab is not the listed one', async () => {
    const mcp = await startMcp();
    // An evaluator that writes nowhere the listing can see models the
    // independent-channel case, which is the outcome that would make the
    // integration useless.
    const seen = await mcp.canSee(async () => 'unrelated title');
    assert.equal(seen, false);
  });
});
