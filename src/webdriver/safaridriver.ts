import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SafariDriverError } from '../common/errors.ts';
import { getFreePort, sleep } from '../common/util.ts';
import { WebDriverClient } from './client.ts';

const execFileAsync = promisify(execFile);

/** Default binary. macOS keeps the real one behind the Cryptex mount. */
export const DEFAULT_SAFARIDRIVER = '/usr/bin/safaridriver';
/** Safari Technology Preview ships its own driver. */
export const TECH_PREVIEW_SAFARIDRIVER =
  '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver';

export interface SafariDriverOptions {
  /** Path to the safaridriver binary. Defaults to {@link DEFAULT_SAFARIDRIVER}. */
  binary?: string;
  /** Port to bind. Defaults to an ephemeral free port. */
  port?: number;
  /** Pass `--diagnose` so the driver writes logs to ~/Library/Logs/com.apple.WebDriver. */
  diagnose?: boolean;
  /** Pipe safaridriver's stdio to the parent process. Useful for debugging. */
  dumpio?: boolean;
  /** ms to wait for the driver's /status endpoint to answer. */
  startTimeout?: number;
}

/**
 * Owns a `safaridriver` child process.
 *
 * safaridriver serves exactly one WebDriver session at a time, so one instance
 * of this class corresponds to one automated Safari window.
 */
export class SafariDriverProcess {
  #process: ChildProcess | null = null;
  #port: number;
  #binary: string;
  #closed = false;

  private constructor(process: ChildProcess, port: number, binary: string) {
    this.#process = process;
    this.#port = port;
    this.#binary = binary;
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get pid(): number | undefined {
    return this.#process?.pid;
  }

  /** Spawn safaridriver and wait until it answers `/status`. */
  static async start(options: SafariDriverOptions = {}): Promise<SafariDriverProcess> {
    const binary = options.binary ?? DEFAULT_SAFARIDRIVER;
    const port = options.port ?? (await getFreePort());
    const startTimeout = options.startTimeout ?? 15_000;

    await assertRemoteAutomationEnabled(binary);

    const args = ['-p', String(port)];
    if (options.diagnose) args.push('--diagnose');

    const child = spawn(binary, args, {
      stdio: options.dumpio ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep a bounded tail so a failed start has a useful message.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    // Held in an object rather than a bare `let`: control-flow analysis would
    // otherwise narrow the variable to `never`, since it is only assigned
    // inside the callback.
    const exit: { info: { code: number | null; signal: NodeJS.Signals | null } | null } = {
      info: null,
    };
    child.once('exit', (code, signal) => {
      exit.info = { code, signal };
    });
    // Without a listener, a spawn failure becomes an unhandled error event.
    child.once('error', () => {});

    const instance = new SafariDriverProcess(child, port, binary);
    const client = new WebDriverClient(instance.url);
    const deadline = Date.now() + startTimeout;

    for (;;) {
      if (exit.info !== null) {
        throw new SafariDriverError(
          `safaridriver exited during startup (code ${exit.info.code}, signal ${exit.info.signal}).\n` +
            (stderr ? `stderr:\n${stderr}\n` : '') +
            hintForStartupFailure(stderr),
        );
      }
      try {
        await client.status();
        return instance;
      } catch {
        if (Date.now() >= deadline) {
          await instance.kill();
          throw new SafariDriverError(
            `safaridriver did not become ready on port ${port} within ${startTimeout}ms.\n` +
              (stderr ? `stderr:\n${stderr}\n` : '') +
              hintForStartupFailure(stderr),
          );
        }
        await sleep(100);
      }
    }
  }

  /** Terminate the driver, escalating to SIGKILL if it lingers. */
  async kill(): Promise<void> {
    if (this.#closed || this.#process === null) return;
    this.#closed = true;
    const child = this.#process;
    this.#process = null;

    if (child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
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
  }
}

/**
 * Verify Safari's "Allow Remote Automation" is on before spawning.
 *
 * This is the single most common setup failure, and safaridriver's own error is
 * opaque, so we surface an actionable message with the exact fix commands.
 */
export async function assertRemoteAutomationEnabled(
  binary: string = DEFAULT_SAFARIDRIVER,
): Promise<void> {
  try {
    await execFileAsync(binary, ['--version'], { timeout: 10_000 });
  } catch (cause) {
    throw new SafariDriverError(
      `Could not run safaridriver at ${binary}: ${(cause as Error).message}\n\n` +
        'To fix:\n' +
        '  1. Confirm the binary exists:  which safaridriver\n' +
        '  2. For Safari Technology Preview, pass:\n' +
        `     launch({ safaridriverPath: '${TECH_PREVIEW_SAFARIDRIVER}' })`,
    );
  }
}

/** Map known safaridriver startup stderr to a concrete remedy. */
function hintForStartupFailure(stderr: string): string {
  const lower = stderr.toLowerCase();

  if (lower.includes('remote automation') || lower.includes('not enabled') || lower.includes('allow remote')) {
    return REMOTE_AUTOMATION_HINT;
  }
  if (lower.includes('address already in use') || lower.includes('could not bind')) {
    return (
      'The port is already in use. Another safaridriver may be running:\n' +
      '  pkill safaridriver\n' +
      'Or omit `port` to let safari-puppeteer pick a free one.'
    );
  }
  return REMOTE_AUTOMATION_HINT;
}

export const REMOTE_AUTOMATION_HINT =
  'Safari must be configured for automation before safaridriver will serve sessions.\n\n' +
  'To fix, run once (it prompts for your password):\n' +
  '  safaridriver --enable\n\n' +
  'Then in Safari:\n' +
  '  1. Settings > Advanced > check "Show features for web developers"\n' +
  '  2. Develop menu > check "Allow Remote Automation"\n\n' +
  'AppleScript features additionally need:\n' +
  '  Develop menu > check "Allow JavaScript from Apple Events"\n' +
  'and Terminal (or your editor) needs Automation permission for Safari in\n' +
  'System Settings > Privacy & Security > Automation.';
