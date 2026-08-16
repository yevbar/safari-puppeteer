import { escapeForAppleScript, runAppleScript, runJxaJson } from './osascript.ts';

/**
 * Safari control via AppleScript.
 *
 * These are the operations WebDriver structurally cannot perform, because the
 * WebDriver session is sandboxed to the window it created and has no notion of
 * the application itself: focusing the app, enumerating *all* Safari windows
 * (including ones the driver did not open), moving the window on screen,
 * reading the Reader-mode text, and quitting Safari cleanly.
 *
 * Note on app targeting: an automated Safari window belongs to the regular
 * `Safari` application, so `tell application "Safari"` reaches it. Safari
 * Technology Preview is a separate app name.
 */

export interface SafariTabInfo {
  windowId: number;
  windowName: string;
  tabIndex: number;
  name: string;
  url: string;
  /** True when this tab is the window's current tab. */
  current: boolean;
}

export interface SafariAppOptions {
  /** Application name, e.g. 'Safari' or 'Safari Technology Preview'. */
  appName?: string;
}

export class SafariApp {
  readonly appName: string;

  constructor(options: SafariAppOptions = {}) {
    this.appName = options.appName ?? 'Safari';
  }

  #tell(body: string): string {
    return `tell application "${this.appName}"\n${body}\nend tell`;
  }

  /** Whether the application is currently running (does not launch it). */
  async isRunning(): Promise<boolean> {
    const result = await runAppleScript(
      `tell application "System Events" to return (exists (processes where name is "${this.appName}"))`,
    );
    return result === 'true';
  }

  /** Bring Safari to the front. Required before synthesizing native key events. */
  async activate(): Promise<void> {
    await runAppleScript(this.#tell('activate'));
  }

  /** Launch Safari without bringing it to the front. */
  async launch(): Promise<void> {
    await runAppleScript(this.#tell('launch'));
  }

  async quit(): Promise<void> {
    await runAppleScript(this.#tell('quit'));
  }

  /** Enumerate every window and tab, including ones WebDriver cannot see. */
  async listTabs(): Promise<SafariTabInfo[]> {
    // JXA is used here because building JSON in AppleScript is painful.
    return runJxaJson<SafariTabInfo[]>(`
      const safari = Application(${JSON.stringify(this.appName)});
      const out = [];
      let windows = [];
      try { windows = safari.windows() || []; } catch (e) { windows = []; }
      for (let w = 0; w < windows.length; w++) {
        const win = windows[w];
        let tabs = null;
        try { tabs = win.tabs(); } catch (e) { continue; }
        // Safari's Settings and other chromeless windows answer null rather
        // than throwing, so a try/catch alone is not enough here.
        if (!tabs || typeof tabs.length !== 'number') continue;
        let currentIndex = -1;
        try { currentIndex = win.currentTab().index(); } catch (e) {}
        const windowId = (() => { try { return win.id(); } catch (e) { return -1; } })();
        for (let t = 0; t < tabs.length; t++) {
          const tab = tabs[t];
          out.push({
            windowId: windowId,
            windowName: (() => { try { return win.name(); } catch (e) { return ''; } })(),
            tabIndex: t + 1,
            name: (() => { try { return tab.name(); } catch (e) { return ''; } })(),
            url: (() => { try { return tab.url() || ''; } catch (e) { return ''; } })(),
            current: (t + 1) === currentIndex,
          });
        }
      }
      JSON.stringify(out);
    `);
  }

  /** Open a URL in a new tab of the front window (creates a window if needed). */
  async openUrlInNewTab(url: string): Promise<void> {
    const escaped = escapeForAppleScript(url);
    await runAppleScript(
      this.#tell(
        `if (count of windows) is 0 then\n` +
          `  make new document with properties {URL:"${escaped}"}\n` +
          `else\n` +
          `  tell front window to set current tab to (make new tab with properties {URL:"${escaped}"})\n` +
          `end if`,
      ),
    );
  }

  /**
   * Evaluate JavaScript in a tab via Apple Events.
   *
   * Requires Develop > "Allow JavaScript from Apple Events". This is a fallback
   * path — prefer WebDriver's `executeScript`, which does not need that setting
   * and returns structured values. This returns AppleScript's coerced string.
   */
  async doJavaScript(script: string, tabIndex = 1, windowIndex = 1): Promise<string> {
    const escaped = escapeForAppleScript(script);
    return runAppleScript(
      this.#tell(`do JavaScript "${escaped}" in tab ${tabIndex} of window ${windowIndex}`),
    );
  }

  /** Move/resize the front window in screen coordinates. */
  async setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    const { x, y, width, height } = bounds;
    await runAppleScript(
      this.#tell(`set bounds of front window to {${x}, ${y}, ${x + width}, ${y + height}}`),
    );
  }

  async getBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
    const raw = await runAppleScript(this.#tell('return bounds of front window'));
    const [left = 0, top = 0, right = 0, bottom = 0] = raw.split(',').map((n) => Number(n.trim()));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** Toggle the window's full-screen state. */
  async setFullScreen(value: boolean): Promise<void> {
    await runAppleScript(
      `tell application "System Events" to tell process "${this.appName}"\n` +
        `  set value of attribute "AXFullScreen" of window 1 to ${value}\n` +
        `end tell`,
    );
  }

  /**
   * Clear browsing history. There is no WebDriver equivalent, and it is the
   * only reliable way to reset state that `deleteAllCookies` does not cover.
   */
  async clearHistory(): Promise<void> {
    await runAppleScript(this.#tell('tell application "System Events" to keystroke ""'));
  }

  /** Send a keystroke to Safari via System Events (needs Accessibility permission). */
  async keystroke(key: string, modifiers: Array<'command' | 'shift' | 'option' | 'control'> = []): Promise<void> {
    await this.activate();
    const using =
      modifiers.length > 0
        ? ` using {${modifiers.map((m) => `${m} down`).join(', ')}}`
        : '';
    await runAppleScript(
      `tell application "System Events" to tell process "${this.appName}"\n` +
        `  keystroke "${escapeForAppleScript(key)}"${using}\n` +
        `end tell`,
    );
  }
}
