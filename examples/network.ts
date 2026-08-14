/**
 * Read-only network inspection, using the MCP backend.
 *
 * The MCP server can only observe tabs it created itself, so this drives the
 * whole page through it — `backend: 'mcp'` rather than the `mcp: true` side
 * channel. That is what makes the requests belong to the page we navigated.
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
  backend: 'mcp',
  safaridriverPath: TECH_PREVIEW_SAFARIDRIVER,
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const [page] = await browser.pages();
  if (!page) throw new Error('No page was opened.');

  // Requests to 127.0.0.1 are never recorded, so a local fixture server would
  // come back empty here.
  await page.goto('https://example.com');

  const observed = await page.networkRequests();
  console.log('Observed requests for the page we navigated:');
  console.log(JSON.stringify(observed, null, 2));

  // Available on this backend and nowhere else.
  await page.emulateMediaType('print');
  console.log('print media matches:', await page.evaluate(() => matchMedia('print').matches));

  // The trade-off, stated by the backend itself.
  console.log('element handles:', page.supports('elementHandles'));
  console.log('cookies        :', page.supports('cookies'));
} finally {
  await browser.close();
}
