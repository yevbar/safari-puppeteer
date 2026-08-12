/**
 * Forms, typing, clicking, waiting, and console capture — against a local
 * fixture page so the example is deterministic and offline.
 *
 * Run: node --experimental-strip-types examples/interact.ts
 */
import { createServer } from 'node:http';

import { launch } from '../src/index.ts';

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>safari-puppeteer demo</title>
<h1>Demo</h1>
<form id="form">
  <input id="name" placeholder="name">
  <select id="color">
    <option value="red">Red</option>
    <option value="blue">Blue</option>
  </select>
  <button type="button" id="go">Go</button>
</form>
<p id="result"></p>
<script>
  document.getElementById('go').addEventListener('click', () => {
    const name = document.getElementById('name').value;
    const color = document.getElementById('color').value;
    console.log('submitting', name, color);
    setTimeout(() => {
      document.getElementById('result').textContent = name + ' likes ' + color;
    }, 300);
  });
</script>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as { port: number };

const browser = await launch({ defaultViewport: { width: 1024, height: 768 } });

try {
  const [page] = await browser.pages();
  if (!page) throw new Error('No page was created.');

  // Console capture is polled, so attach the listener before navigating.
  page.on('console', (message) => {
    console.log(`[page ${message.type}]`, message.text);
  });

  await page.goto(`http://127.0.0.1:${port}/`);

  await page.type('#name', 'Ada');
  await page.select('#color', 'blue');
  await page.click('#go');

  // The result is filled in asynchronously; wait for it rather than sleeping.
  await page.waitForFunction(
    () => document.getElementById('result')!.textContent!.length > 0,
  );

  console.log('result:', await page.$eval('#result', (el: Element) => el.textContent));

  // Keyboard and mouse go through the WebDriver Actions API.
  await page.focus('#name');
  await page.keyboard.press('Backspace');
  console.log('after backspace:', await page.$eval('#name', (el: HTMLInputElement) => el.value));
} finally {
  await browser.close();
  server.close();
}
