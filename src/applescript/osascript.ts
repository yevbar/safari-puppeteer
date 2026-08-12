import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SafariPuppeteerError } from '../common/errors.ts';

const execFileAsync = promisify(execFile);

export class AppleScriptError extends SafariPuppeteerError {
  override name = 'AppleScriptError';
}

export interface OsascriptOptions {
  /** ms before the script is aborted. */
  timeout?: number;
  /** Arguments exposed to the script as `argv` (AppleScript `on run argv`). */
  args?: string[];
}

/**
 * Run an AppleScript source string via `osascript` and return stdout, trimmed.
 *
 * The script is passed on stdin rather than as `-e` arguments so that multi-line
 * scripts and embedded quotes survive intact.
 */
export async function runAppleScript(source: string, options: OsascriptOptions = {}): Promise<string> {
  return runOsascript(['-l', 'AppleScript', '-'], source, options);
}

/**
 * Run JavaScript for Automation (JXA). Preferred when the script needs to build
 * or parse JSON, which AppleScript handles poorly.
 */
export async function runJxa(source: string, options: OsascriptOptions = {}): Promise<string> {
  return runOsascript(['-l', 'JavaScript', '-'], source, options);
}

/** Run a JXA script whose final expression is JSON text, and parse it. */
export async function runJxaJson<T>(source: string, options: OsascriptOptions = {}): Promise<T> {
  const stdout = await runJxa(source, options);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new AppleScriptError(
      `Expected JSON from JXA script but got: ${stdout.slice(0, 500)}`,
    );
  }
}

async function runOsascript(
  baseArgs: string[],
  source: string,
  options: OsascriptOptions,
): Promise<string> {
  const args = [...baseArgs, ...(options.args ?? [])];
  const child = execFileAsync('/usr/bin/osascript', args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  child.child.stdin?.end(source);

  try {
    const { stdout } = await child;
    return stdout.trimEnd();
  } catch (cause) {
    const error = cause as { stderr?: string; message: string; killed?: boolean };
    const stderr = (error.stderr ?? '').trim();
    throw new AppleScriptError(
      `osascript failed: ${stderr || error.message}\n${hintForAppleScriptError(stderr)}`,
    );
  }
}

function hintForAppleScriptError(stderr: string): string {
  const lower = stderr.toLowerCase();

  if (lower.includes('not allowed') || lower.includes('-1743') || lower.includes('not authorized')) {
    return (
      '\nThis process lacks Automation permission for Safari.\n' +
      'To fix: System Settings > Privacy & Security > Automation >\n' +
      '  enable Safari under your terminal/editor.\n' +
      'If the app is not listed, trigger the prompt by running:\n' +
      "  osascript -e 'tell application \"Safari\" to get name of front window'"
    );
  }
  if (lower.includes('apple events') || lower.includes('-2700') || lower.includes('do javascript')) {
    return (
      '\n`do JavaScript` requires Safari to allow it.\n' +
      'To fix, in Safari: Settings > Advanced > "Show features for web developers",\n' +
      '  then Develop menu > "Allow JavaScript from Apple Events".'
    );
  }
  return '';
}

/** Escape a JS string for safe embedding inside an AppleScript string literal. */
export function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
