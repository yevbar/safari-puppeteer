/**
 * Read-only network inspection via the MCP channel.
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
  const [page] = await browser.pages();
  if (!page) throw new Error('No page was opened.');

  await page.goto('https://example.com');

  // Observation only — there is no way to block or rewrite these.
  const requests = await page.networkRequests();
  console.log('Observed requests:');
  console.log(JSON.stringify(requests, null, 2));

  // The one mutating capability the MCP channel adds.
  await page.emulateMediaFeatures({ 'prefers-color-scheme': 'dark' });
  const isDark = await page.evaluate<boolean>(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  console.log('prefers-color-scheme: dark ->', isDark);

  // Anything not wrapped is reachable through the raw client.
  const mcp = await browser.mcp();
  console.log('Tools advertised:', mcp.tools.map((tool) => tool.name).join(', '));
} finally {
  await browser.close();
}
