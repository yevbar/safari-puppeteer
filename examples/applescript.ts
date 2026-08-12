/**
 * The AppleScript half of the library.
 *
 * WebDriver can only see the window it created. AppleScript sees the whole
 * Safari application — including the user's own windows and tabs, which is the
 * main reason this project pairs the two.
 *
 * Run: node --experimental-strip-types examples/applescript.ts
 */
import { SafariApp } from '../src/applescript/safari.ts';

const safari = new SafariApp();

if (!(await safari.isRunning())) {
  console.log('Safari is not running; launching it.');
  await safari.launch();
}

// Every window and tab, including ones no WebDriver session can reach.
const tabs = await safari.listTabs();
console.log(`${tabs.length} tab(s) open:\n`);
for (const tab of tabs) {
  const marker = tab.current ? '*' : ' ';
  console.log(`${marker} [win ${tab.windowId} tab ${tab.tabIndex}] ${tab.name}`);
  console.log(`     ${tab.url}`);
}

// Window geometry, which WebDriver can only do for its own window.
const bounds = await safari.getBounds().catch(() => null);
if (bounds) {
  console.log('\nfront window bounds:', bounds);
}
