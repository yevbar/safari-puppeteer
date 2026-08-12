import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Whether the macOS login session's screen is locked.
 *
 * This matters more than it sounds. While the screen is locked no window can
 * become the key window, so the OS never delivers synthesized *pointer* events
 * to Safari. Both WebDriver's element click and the Actions API return success
 * and do nothing — no error, no event. Scripts then hang in whatever `waitFor*`
 * was expecting the click to satisfy.
 *
 * Measured on Safari 18.6: mouse and pointer events are lost, while keyboard
 * events (`sendKeys`, Actions key input) and JavaScript-dispatched events
 * (`element.click()` inside `page.evaluate`) still work. That partial failure
 * is what makes this so confusing to diagnose.
 *
 * Returns `false` if the state cannot be determined, so this never blocks work
 * on the basis of a failed probe.
 */
export async function isScreenLocked(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    // The key is absent entirely when the screen has never been locked.
    const match = /<key>CGSSessionScreenIsLocked<\/key>\s*<(true|false)\/>/.exec(stdout);
    return match?.[1] === 'true';
  } catch {
    return false;
  }
}

/** Explanation shown when native input silently does nothing. */
export const SCREEN_LOCKED_HINT =
  'The macOS screen is locked, so no Safari window can become the key window and\n' +
  'synthesized pointer events are never delivered. page.click(), mouse.click(),\n' +
  'hover(), and tap() report success but do nothing, and anything waiting on their\n' +
  'effect times out.\n\n' +
  'To fix: unlock the screen and keep the session active for the duration of the run.\n' +
  'Still working while locked: navigation, page.evaluate(), screenshots, cookies,\n' +
  'and keyboard input (page.type / keyboard.press).';
