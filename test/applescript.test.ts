/**
 * AppleScript bridge tests — these drive the *real* Safari, not an automation
 * window.
 *
 * That is the whole point of the bridge, and also why it went untested for so
 * long: a WebDriver session cannot stand in for it. `listTabs()` shipped broken
 * because it was only ever run against tidy automation windows, and a real
 * Safari has windows that a WebDriver session never produces — Settings panes
 * answer `null` for `tabs()` rather than throwing.
 *
 * Everything here is read-only except one tab this suite opens and closes
 * itself, so running it does not disturb an existing browsing session.
 *
 * Run: npm run test:applescript
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { SafariApp } from '../src/applescript/safari.ts';
import { AppleScriptError, escapeForAppleScript, runAppleScript } from '../src/applescript/osascript.ts';
import { UnsupportedOperationError } from '../src/common/errors.ts';

const safari = new SafariApp();

/** Set when Safari is not running or automation is not permitted. */
let skipReason: string | null = null;
/** Set when Develop > "Allow JavaScript from Apple Events" is off. */
let jsSkipReason: string | null = null;

before(async () => {
  try {
    if (!(await safari.isRunning())) {
      skipReason = 'Safari is not running. Open Safari and re-run.';
      return;
    }
    await safari.listTabs();
  } catch (cause) {
    skipReason =
      `AppleScript is unavailable: ${(cause as Error).message.split('\n')[0]}\n` +
      'Grant Automation permission: System Settings > Privacy & Security > Automation.';
    return;
  }

  try {
    await safari.doJavaScript('1');
  } catch (cause) {
    jsSkipReason =
      `do JavaScript is not permitted: ${(cause as Error).message.split('\n')[0]}\n` +
      'Enable Safari > Develop > "Allow JavaScript from Apple Events".';
  }
});

function appleTest(name: string, body: () => Promise<void>): void {
  it(name, async (t) => {
    if (skipReason !== null) {
      t.skip(skipReason);
      return;
    }
    await body();
  });
}

function jsTest(name: string, body: () => Promise<void>): void {
  it(name, async (t) => {
    const reason = skipReason ?? jsSkipReason;
    if (reason !== null) {
      t.skip(reason);
      return;
    }
    await body();
  });
}

describe('escapeForAppleScript', () => {
  it('escapes the two characters that break a string literal', () => {
    assert.equal(escapeForAppleScript('plain'), 'plain');
    assert.equal(escapeForAppleScript('quote"inside'), 'quote\\"inside');
    assert.equal(escapeForAppleScript('back\\slash'), 'back\\\\slash');
  });

  it('escapes backslashes before quotes, not after', () => {
    // Getting the order wrong turns \" into \\" and breaks the literal.
    assert.equal(escapeForAppleScript('\\"'), '\\\\\\"');
  });

  it('leaves newlines and unicode alone', () => {
    // Scripts are fed to osascript on stdin, where a raw newline inside a
    // literal is accepted, so escaping them is unnecessary.
    assert.equal(escapeForAppleScript('a\nb'), 'a\nb');
    assert.equal(escapeForAppleScript('héllo ✓ 日本'), 'héllo ✓ 日本');
  });
});

describe('osascript', () => {
  it('accepts a raw newline inside a string literal', async () => {
    assert.equal(await runAppleScript('return "a\nb"'), 'a\nb');
  });

  it('reports a script error as an AppleScriptError', async () => {
    await assert.rejects(() => runAppleScript('this is not applescript'), AppleScriptError);
  });
});

describe('SafariApp against a real Safari', () => {
  appleTest('reports whether Safari is running', async () => {
    assert.equal(await safari.isRunning(), true);
  });

  appleTest('reports a never-launched app as not running rather than launching it', async () => {
    const absent = new SafariApp({ appName: 'No Such Browser 12345' });
    assert.equal(await absent.isRunning(), false);
  });

  /**
   * The regression that motivated this suite: a Settings window answers `null`
   * from `tabs()` instead of throwing, so one open pane took out the whole
   * enumeration.
   */
  appleTest('enumerates tabs without being broken by tabless windows', async () => {
    const tabs = await safari.listTabs();
    assert.ok(Array.isArray(tabs));
    for (const tab of tabs) {
      assert.equal(typeof tab.windowId, 'number');
      assert.equal(typeof tab.tabIndex, 'number');
      assert.equal(typeof tab.name, 'string');
      assert.equal(typeof tab.url, 'string');
      assert.equal(typeof tab.current, 'boolean');
    }
    // Indices are per-window and 1-based.
    assert.ok(tabs.every((tab) => tab.tabIndex >= 1));
  });

  appleTest('sees tabs a WebDriver session cannot', async () => {
    // The bridge's reason to exist: these are the user's own tabs, outside any
    // automation session.
    const tabs = await safari.listTabs();
    assert.ok(tabs.length > 0, 'expected at least one open tab in the real Safari');
  });

  appleTest('reads the front window geometry', async () => {
    const bounds = await safari.getBounds();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      assert.equal(typeof bounds[key], 'number', `${key} should be a number`);
      assert.ok(Number.isFinite(bounds[key]));
    }
    assert.ok(bounds.width > 0 && bounds.height > 0);
  });

  appleTest('opens and closes a tab without disturbing the others', async () => {
    const before = await safari.listTabs();

    await safari.openUrlInNewTab('about:blank');
    const during = await safari.listTabs();
    assert.equal(during.length, before.length + 1, 'expected exactly one new tab');

    await runAppleScript('tell application "Safari" to close current tab of front window');
    const after = await safari.listTabs();
    assert.equal(after.length, before.length, 'the opened tab should be gone');
  });

  appleTest('refuses clearHistory instead of silently doing nothing', async () => {
    // It used to send an empty keystroke and report success.
    await assert.rejects(() => safari.clearHistory(), UnsupportedOperationError);
  });
});

describe('SafariApp.doJavaScript', () => {
  jsTest('evaluates an expression in a real tab', async () => {
    // AppleScript coerces numbers to reals on the way out.
    assert.equal(await safari.doJavaScript('1 + 1'), '2.0');
  });

  jsTest('survives quotes, apostrophes, tabs and unicode', async () => {
    assert.equal(await safari.doJavaScript('"he said \\"hi\\""'), 'he said "hi"');
    assert.equal(await safari.doJavaScript("'it\\'s'"), "it's");
    assert.equal(await safari.doJavaScript('"a\\tb"'), 'a\tb');
    assert.equal(await safari.doJavaScript('"héllo ✓ 日本"'), 'héllo ✓ 日本');
  });

  jsTest('survives a multi-line script', async () => {
    // Raw newlines reach osascript intact via stdin. The IIFE matters: the
    // script shares the page's global scope, so bare `const` declarations
    // would throw on the second run against the same tab.
    const source = '(() => {\n  const a = 1;\n  const b = 2;\n  return a + b;\n})()';
    assert.equal(await safari.doJavaScript(source), '3.0');
  });

  jsTest('swallows a page-side exception, returning empty', async () => {
    // Documented limitation rather than desired behaviour: a throwing script is
    // indistinguishable from one returning null, which is a good reason to
    // prefer page.evaluate() when a WebDriver session is available.
    assert.equal(await safari.doJavaScript('throw new Error("boom")'), '');
    assert.equal(await safari.doJavaScript('null'), '');
    assert.equal(await safari.doJavaScript('undefined'), '');
  });
});
