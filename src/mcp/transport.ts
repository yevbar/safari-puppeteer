/**
 * Minimal MCP client over stdio.
 *
 * `safaridriver --mcp` speaks the Model Context Protocol: JSON-RPC 2.0 messages
 * over stdin/stdout, one JSON object per line (the MCP stdio transport is
 * newline-delimited, *not* LSP-style `Content-Length` framing). We implement
 * just the three methods we need — `initialize`, `tools/list`, `tools/call` —
 * rather than depending on the official SDK, which would pull a runtime
 * dependency into a package that currently has none.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { McpError } from '../common/errors.ts';

/** MCP revision we advertise. Servers negotiate down if they speak an older one. */
export const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A tool as reported by `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** The `tools/call` result envelope. */
export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpTransportOptions {
  /** Binary to spawn. */
  binary: string;
  /** Arguments. Defaults to `['--mcp']`. */
  args?: string[];
  /** ms to wait for any single request to answer. */
  timeout?: number;
  /** Pipe the server's stderr to this process. */
  dumpio?: boolean;
}

/**
 * Owns the `safaridriver --mcp` child process and the JSON-RPC conversation
 * with it.
 */
export class McpTransport {
  #process: ChildProcess | null = null;
  #binary: string;
  #args: string[];
  #timeout: number;
  #dumpio: boolean;

  #nextId = 0;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }
  >();
  #buffer = '';
  #stderr = '';
  #closed = false;
  #exitReason: string | null = null;

  constructor(options: McpTransportOptions) {
    this.#binary = options.binary;
    this.#args = options.args ?? ['--mcp'];
    this.#timeout = options.timeout ?? 30_000;
    this.#dumpio = options.dumpio ?? false;
  }

  get running(): boolean {
    return this.#process !== null && !this.#closed;
  }

  /** Tail of the server's stderr, kept for diagnostics. */
  get stderr(): string {
    return this.#stderr;
  }

  /** Spawn the server and complete the MCP handshake. */
  async start(): Promise<{ serverInfo: unknown; capabilities: unknown }> {
    if (this.#process !== null) {
      throw new McpError('MCP transport already started.');
    }

    const child = spawn(this.#binary, this.#args, {
      stdio: ['pipe', 'pipe', this.#dumpio ? 'inherit' : 'pipe'],
    });
    this.#process = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-8000);
    });

    child.once('error', (error: Error) => {
      this.#fail(`Could not spawn ${this.#binary}: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      this.#fail(
        `safaridriver --mcp exited (code ${code}, signal ${signal}).` +
          (this.#stderr ? `\nstderr:\n${this.#stderr}` : ''),
      );
    });

    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'safari-puppeteer', version: '0.1.0' },
    })) as { serverInfo?: unknown; capabilities?: unknown };

    // Per spec the client confirms with a notification before issuing calls.
    this.notify('notifications/initialized');

    return { serverInfo: result?.serverInfo ?? null, capabilities: result?.capabilities ?? null };
  }

  /** List the tools the server exposes. */
  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpTool[] };
    return result?.tools ?? [];
  }

  /**
   * Invoke a tool.
   *
   * MCP reports tool-level failures inside a successful response (`isError`)
   * rather than as a JSON-RPC error, so both are normalized to a throw here.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = (await this.request('tools/call', {
      name,
      arguments: args,
    }).catch((cause: Error) => {
      throw new McpError(`MCP tool "${name}" failed: ${cause.message}`, { tool: name });
    })) as McpToolResult;

    if (result?.isError) {
      throw new McpError(`MCP tool "${name}" reported an error: ${textOf(result)}`, { tool: name });
    }
    return result;
  }

  /** Send a JSON-RPC request and await its response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed || this.#process === null) {
      return Promise.reject(
        new McpError(this.#exitReason ?? 'MCP transport is not running.'),
      );
    }

    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${this.#timeout}ms.`));
      }, this.#timeout);
      timer.unref();

      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown = {}): void {
    if (this.#closed || this.#process === null) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** Shut the server down. */
  async stop(): Promise<void> {
    if (this.#process === null || this.#closed) return;
    const child = this.#process;
    this.#fail('MCP transport was stopped.');

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin?.end();
    child.kill('SIGTERM');

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 3000);
    timer.unref();

    await exited;
    clearTimeout(timer);
    this.#process = null;
  }

  #write(message: unknown): void {
    this.#process?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;

    // Newline-delimited JSON. A partial trailing line stays in the buffer.
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === '') continue;

      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Servers sometimes print banner text on stdout before the protocol
        // starts. Ignoring non-JSON lines is more robust than failing.
        continue;
      }

      // Server-initiated requests and notifications are not something we
      // subscribe to; only responses to our own ids are routed.
      if (typeof message.id !== 'number') continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(
          new McpError(`MCP error ${message.error.code}: ${message.error.message}`, {
            code: message.error.code,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  /** Reject everything in flight and mark the transport dead. */
  #fail(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#exitReason = reason;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new McpError(reason));
    }
    this.#pending.clear();
  }
}

/** Concatenate the text parts of a tool result. */
export function textOf(result: McpToolResult): string {
  return (result?.content ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * Best-effort structured view of a tool result.
 *
 * Servers may answer with `structuredContent`, with a JSON string in a text
 * part, or with prose. We try each in turn rather than assuming one shape,
 * because the exact envelope varies between MCP server implementations.
 */
export function jsonOf(result: McpToolResult): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
