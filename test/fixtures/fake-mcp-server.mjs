#!/usr/bin/env node
/**
 * A stand-in for `safaridriver --mcp`.
 *
 * Speaks the same MCP stdio dialect — newline-delimited JSON-RPC 2.0 — so the
 * transport can be tested on any machine, including CI runners with no Safari
 * Technology Preview. The tool list and argument names mirror what STP 249
 * actually advertises (captured from a live server), so a drift between this
 * fixture and the real thing shows up as a test failure rather than a runtime
 * surprise.
 *
 * Behaviours it deliberately reproduces:
 *   - `--help` mentions `--mcp`, so capability detection can be exercised
 *   - a banner line on stdout before the protocol starts
 *   - tool-level failures reported via `isError`, not JSON-RPC `error`
 *   - the real server's "Allow remote automation" error text
 */
import { createInterface } from 'node:readline';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'Usage: safaridriver [options]\n' +
      '\t--mcp                     Run as an MCP (Model Context Protocol) server using stdio\n',
  );
  process.exit(0);
}

if (process.argv.includes('--no-mcp-support')) {
  process.stdout.write('Usage: safaridriver [options]\n\t-p, --port\n');
  process.exit(0);
}

const FAIL_REMOTE_AUTOMATION = process.argv.includes('--fail-remote-automation');

const TOOLS = [
  { name: 'browser_console_messages', inputSchema: { type: 'object', properties: { clear: {}, level_filter: {}, limit: {}, tab_handle: {} }, required: [] } },
  { name: 'browser_dialogs', inputSchema: { type: 'object', properties: { action: {}, inputText: {} }, required: ['action'] } },
  { name: 'close_tab', inputSchema: { type: 'object', properties: { handle: {} }, required: ['handle'] } },
  { name: 'create_tab', inputSchema: { type: 'object', properties: { url: {} }, required: [] } },
  { name: 'evaluate_javascript', inputSchema: { type: 'object', properties: { expression: {}, frameId: {} }, required: ['expression'] } },
  { name: 'get_network_request', inputSchema: { type: 'object', properties: { request_id: {} }, required: ['request_id'] } },
  { name: 'get_page_content', inputSchema: { type: 'object', properties: { format: {} }, required: [] } },
  { name: 'list_network_requests', inputSchema: { type: 'object', properties: { clear: {}, filter: {}, since: {}, tab_handle: {} }, required: [] } },
  { name: 'list_tabs', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'navigate_to_url', inputSchema: { type: 'object', properties: { handle: {}, url: {} }, required: ['url'] } },
  { name: 'page_info', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'page_interactions', inputSchema: { type: 'object', properties: { fullText: {}, interactions: {} }, required: ['interactions'] } },
  { name: 'screenshot', inputSchema: { type: 'object', properties: { full_page: {}, node: {}, savePath: {} }, required: [] } },
  { name: 'set_emulated_media', inputSchema: { type: 'object', properties: { media: {} }, required: ['media'] } },
  { name: 'set_viewport_size', inputSchema: { type: 'object', properties: { height: {}, width: {} }, required: ['width', 'height'] } },
  { name: 'switch_tab', inputSchema: { type: 'object', properties: { handle: {} }, required: ['handle'] } },
  { name: 'wait_for_navigation', inputSchema: { type: 'object', properties: { timeout_seconds: {} }, required: [] } },
];

/** Mutable state so tests can observe the effect of calls. */
const state = {
  title: 'Fake Page',
  emulatedMedia: null,
  lastArgs: {},
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const toolError = (message) => ({ content: [{ type: 'text', text: `Tool error: ${message}` }], isError: true });

const REMOTE_AUTOMATION_ERROR =
  'Error Domain=WebDriverErrorDomain Code=6 "Could not create a session: You must enable ' +
  "'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver.\"";

function callTool(name, args) {
  state.lastArgs[name] = args;

  if (FAIL_REMOTE_AUTOMATION) return toolError(REMOTE_AUTOMATION_ERROR);

  switch (name) {
    case 'list_tabs':
      return text({ tabs: [{ handle: 'tab-1', title: state.title, url: 'https://example.com/', active: true }] });
    case 'page_info':
      return text({ title: state.title, url: 'https://example.com/' });
    case 'evaluate_javascript': {
      // Enough of an evaluator to drive the attach probe end to end.
      const expression = String(args.expression ?? '');
      const assignment = /document\.title\s*=\s*("(?:[^"\\]|\\.)*")/.exec(expression);
      const previous = state.title;
      if (assignment) state.title = JSON.parse(assignment[1]);
      if (expression.includes('const t = document.title')) return text(previous);
      if (assignment) return text(null);
      if (expression.includes('document.title')) return text(state.title);
      return text({ expression });
    }
    case 'list_network_requests':
      return text({
        requests: [
          { request_id: 'req-1', url: 'https://example.com/', method: 'GET', status: 200, type: 'document' },
          { request_id: 'req-2', url: 'https://example.com/app.js', method: 'GET', status: 200, type: 'script' },
        ],
      });
    case 'get_network_request':
      return args.request_id === 'req-1'
        ? text({ request_id: 'req-1', url: 'https://example.com/', requestHeaders: { accept: '*/*' }, status: 200 })
        : toolError(`No request with id ${args.request_id}`);
    case 'browser_console_messages':
      return text({ messages: [{ level: 'log', text: 'hello', url: 'https://example.com/' }] });
    case 'set_emulated_media':
      state.emulatedMedia = args.media;
      return text('ok');
    case 'screenshot':
      return { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
    case 'get_page_content':
      return text('<html><body>fake</body></html>');
    default:
      return text('ok');
  }
}

// A banner before the protocol starts: the transport must tolerate this.
process.stdout.write('safaridriver MCP server\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Notifications carry no id and expect no response.
  if (message.id === undefined) return;

  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'Safari', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const { name, arguments: args = {} } = message.params ?? {};
      if (!TOOLS.some((tool) => tool.name === name)) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, result: callTool(name, args) });
      return;
    }
    case 'never/responds':
      // Used to exercise the request timeout.
      return;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  }
});
