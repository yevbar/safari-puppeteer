/**
 * Read-only network inspection via the MCP channel.
 *
 * Note what this example does *not* do: it never inspects traffic for a page
 * driven with page.goto(). The MCP server is a separate browsing context that
 * only sees tabs it created itself, so the tab has to come from mcp.createTab()
 * and the navigation has to happen after that. See the README.
 *
 * Requires Safari Technology Preview 247+ with remote automation enabled in
 * Technology Preview itself (its settings are separate from Safari's):
 *
 *   brew install --cask safari-technology-preview
 *   "/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver" --enable
 *
 * Run: node --experimental-strip-types examples/network.ts
 */
import { isMcpSupported, launch, TECH_PREVIEW_SAFARIDRIVER } from '../src/index.ts';

if (!(await isMcpSupported(TECH_PREVIEW_SAFARIDRIVER))) {
  console.error(
    'Safari Technology Preview 247+ is required for the MCP channel.\n' +
      '  brew install --cask safari-technology-preview',
  );
  process.exit(1);
}

const browser = await launch({
  mcp: true,
  safaridriverPath: TECH_PREVIEW_SAFARIDRIVER,
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const mcp = await browser.mcp();

  // The MCP server must own the tab, and capture only covers navigations made
  // after it exists — so create, switch, *then* navigate.
  const tab = (await mcp.createTab()) as { handle: string };
  await mcp.switchTab(tab.handle);
  await mcp.navigate('https://example.com/', tab.handle);

  // Requests to 127.0.0.1 are never recorded, so a local fixture server would
  // come back empty here.
  const observed = await mcp.listNetworkRequests({ tabHandle: tab.handle });
  console.log('Observed requests:');
  console.log(JSON.stringify(observed, null, 2));

  await mcp.closeTab(tab.handle);

  // Meanwhile the WebDriver session is a completely separate browser context.
  const [page] = await browser.pages();
  if (page) {
    await page.goto('https://example.com');
    console.log('WebDriver page title:', await page.title());
    console.log('Tabs visible to MCP:', JSON.stringify(await mcp.listTabs()));
  }
} finally {
  await browser.close();
}
