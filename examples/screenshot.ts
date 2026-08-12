/**
 * Basic screenshot example — the "does this work at all" smoke test.
 *
 * Run: npm run example
 */
import { launch } from '../src/index.ts';

const browser = await launch({
  defaultViewport: { width: 1280, height: 800 },
});

try {
  const [page] = await browser.pages();
  if (!page) throw new Error('No page was created.');

  await page.goto('https://example.com', { waitUntil: 'load' });

  console.log('title:', await page.title());
  console.log('url:  ', await page.url());

  const heading = await page.$eval('h1', (element: Element) => element.textContent);
  console.log('h1:   ', heading);

  await page.screenshot({ path: 'example.png' });
  console.log('wrote example.png');
} finally {
  await browser.close();
}
