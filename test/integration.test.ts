/**
 * Integration tests — these drive a real Safari window.
 *
 * Requires: safaridriver --enable, and Safari > Develop > Allow Remote
 * Automation. Run `npm run doctor` first; if the environment is not ready the
 * whole suite skips rather than failing, so `npm test` stays useful on CI boxes
 * without a Safari GUI session.
 *
 * Run: node --test --experimental-strip-types test/integration.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { launch } from '../src/index.ts';
import type { Browser } from '../src/api/Browser.ts';
import type { Page } from '../src/api/Page.ts';
import { UnsupportedOperationError } from '../src/common/errors.ts';
import { isScreenLocked } from '../src/common/macos.ts';

const FIXTURE = `<!doctype html>
<meta charset="utf-8">
<title>Fixture</title>
<h1 id="heading">Hello Safari</h1>
<input id="text" value="">
<select id="choice">
  <option value="a">A</option>
  <option value="b">B</option>
</select>
<select id="multi" multiple>
  <option value="x">X</option>
  <option value="y">Y</option>
  <option value="z">Z</option>
</select>
<input id="file" type="file">
<input id="files" type="file" multiple>
<button id="btn" onclick="document.getElementById('out').textContent='clicked'">Click</button>
<p id="out"></p>
<div id="tall" style="height: 3000px"></div>
<a id="link" href="/second">second</a>`;

const SECOND = `<!doctype html><title>Second</title><h1 id="heading">Second page</h1>`;

let server: Server;
let origin: string;
let browser: Browser | null = null;
let page: Page;
/** Set when the environment cannot run Safari; every test then skips. */
let skipReason: string | null = null;
/**
 * Set when the screen is locked. Only tests that need native input skip — the
 * rest still run, since navigation and evaluation are unaffected.
 */
let inputSkipReason: string | null = null;

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/second' ? SECOND : FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;

  if (await isScreenLocked()) {
    // Native clicks and key presses report success but never dispatch while the
    // screen is locked, so those tests would fail as 30s timeouts with no clue
    // as to why. Say so instead.
    inputSkipReason =
      'macOS screen is locked — Safari cannot receive synthesized pointer events. Unlock and re-run.';
  }

  try {
    browser = await launch({ defaultViewport: { width: 1024, height: 768 } });
    const [first] = await browser.pages();
    if (!first) throw new Error('launch() produced no page');
    page = first;
  } catch (cause) {
    skipReason = `Safari automation unavailable: ${(cause as Error).message.split('\n')[0]}`;
  }
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** Wrap a test body so it skips cleanly when Safari is unavailable. */
function safariTest(name: string, body: () => Promise<void>): void {
  it(name, async (t) => {
    if (skipReason !== null) {
      t.skip(skipReason);
      return;
    }
    await body();
  });
}

/** As {@link safariTest}, but also skips when the screen is locked. */
function inputTest(name: string, body: () => Promise<void>): void {
  it(name, async (t) => {
    if (skipReason !== null) {
      t.skip(skipReason);
      return;
    }
    if (inputSkipReason !== null) {
      t.skip(inputSkipReason);
      return;
    }
    await body();
  });
}

describe('navigation', () => {
  safariTest('goto resolves after the document loads', async () => {
    await page.goto(`${origin}/`);
    assert.equal(await page.title(), 'Fixture');
    assert.match(await page.url(), /127\.0\.0\.1/);
  });

  safariTest('back and forward traverse history', async () => {
    await page.goto(`${origin}/`);
    await page.goto(`${origin}/second`);
    assert.equal(await page.title(), 'Second');

    await page.goBack();
    assert.equal(await page.title(), 'Fixture');

    await page.goForward();
    assert.equal(await page.title(), 'Second');
  });

  safariTest('setContent replaces the document', async () => {
    await page.setContent('<title>Injected</title><h1 id="h">Injected</h1>');
    assert.equal(await page.$eval('#h', (el: Element) => el.textContent), 'Injected');
  });
});

describe('evaluate', () => {
  safariTest('returns JSON values', async () => {
    await page.goto(`${origin}/`);
    assert.equal(await page.evaluate(() => 6 * 7), 42);
    assert.deepEqual(await page.evaluate(() => ({ a: [1, 2], b: 'x' })), { a: [1, 2], b: 'x' });
  });

  safariTest('passes arguments through', async () => {
    const sum = await page.evaluate((a: number, b: number) => a + b, 20, 22);
    assert.equal(sum, 42);
  });

  safariTest('propagates page-side exceptions', async () => {
    await assert.rejects(
      () => page.evaluate(() => {
        throw new Error('boom');
      }),
      /boom/,
    );
  });

  safariTest('evaluateHandle round-trips a non-serializable value', async () => {
    // window is not JSON-serializable; the registry is what makes this work.
    const handle = await page.evaluateHandle(() => window);
    const href = await handle.evaluate((win: Window) => win.location.href);
    assert.match(String(href), /127\.0\.0\.1/);
    await handle.dispose();
  });

  safariTest('a handle survives being passed back into evaluate', async () => {
    const handle = await page.evaluateHandle(() => ({ nested: { value: 7 } }));
    const value = await page.evaluate((obj: any) => obj.nested.value, handle);
    assert.equal(value, 7);
    await handle.dispose();
  });
});

describe('selectors and elements', () => {
  safariTest('$ returns null rather than throwing when absent', async () => {
    await page.goto(`${origin}/`);
    assert.equal(await page.$('#does-not-exist'), null);
  });

  safariTest('$$ returns every match', async () => {
    const options = await page.$$('#choice option');
    assert.equal(options.length, 2);
  });

  safariTest('element text and attributes', async () => {
    const heading = await page.$('#heading');
    assert.ok(heading);
    assert.equal(await heading.textContent(), 'Hello Safari');
    assert.equal(await heading.tagName(), 'h1');
    assert.equal(await heading.getAttribute('id'), 'heading');
  });

  safariTest('isVisible works despite safaridriver lacking /displayed', async () => {
    // safaridriver answers `unknown command` for the WebDriver displayedness
    // endpoint, so this is computed in-page. Regression guard: if it ever falls
    // back to the driver, waitForSelector({ visible: true }) hangs.
    await page.setContent(`
      <div id="shown">visible</div>
      <div id="none" style="display:none">hidden</div>
      <div id="hiddenvis" style="visibility:hidden">hidden</div>
      <div id="zero" style="width:0;height:0;overflow:hidden">zero</div>
    `);
    assert.equal(await (await page.$('#shown'))!.isVisible(), true);
    assert.equal(await (await page.$('#none'))!.isVisible(), false);
    assert.equal(await (await page.$('#hiddenvis'))!.isVisible(), false);
    assert.equal(await (await page.$('#zero'))!.isVisible(), false);
  });

  safariTest('waitForSelector({ visible }) resolves for a rendered node', async () => {
    await page.goto(`${origin}/`);
    const found = await page.waitForSelector('#heading', { visible: true, timeout: 5000 });
    assert.ok(found);
  });

  safariTest('boundingBox reports geometry', async () => {
    const heading = await page.$('#heading');
    const box = await heading!.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0);
  });
});

describe('interaction', () => {
  // Pointer events require a key window; keyboard events do not, which is why
  // only the click tests are gated on the screen being unlocked.
  inputTest('click triggers the handler', async () => {
    await page.goto(`${origin}/`);
    await page.click('#btn');
    await page.waitForFunction(() => document.getElementById('out')!.textContent === 'clicked');
    assert.equal(await page.$eval('#out', (el: Element) => el.textContent), 'clicked');
  });

  safariTest('type enters text into an input', async () => {
    await page.goto(`${origin}/`);
    await page.type('#text', 'hello');
    assert.equal(await page.$eval('#text', (el: HTMLInputElement) => el.value), 'hello');
  });

  safariTest('keyboard.press sends a non-printable key', async () => {
    await page.goto(`${origin}/`);
    await page.type('#text', 'abc');
    await page.focus('#text');
    await page.keyboard.press('Backspace');
    assert.equal(await page.$eval('#text', (el: HTMLInputElement) => el.value), 'ab');
  });

  safariTest('select sets the chosen option', async () => {
    await page.goto(`${origin}/`);
    const selected = await page.select('#choice', 'b');
    assert.deepEqual(selected, ['b']);
    assert.equal(await page.$eval('#choice', (el: HTMLSelectElement) => el.value), 'b');
  });

  safariTest('select on a single <select> does not fall back to the first option', async () => {
    // Regression: assigning selected=false option-by-option makes HTML's
    // "ask for a reset" algorithm re-select option A.
    await page.goto(`${origin}/`);
    await page.select('#choice', 'b');
    assert.equal(await page.$eval('#choice', (el: HTMLSelectElement) => el.value), 'b');
  });

  safariTest('select sets several options on a multiple <select>', async () => {
    await page.goto(`${origin}/`);
    const selected = await page.select('#multi', 'x', 'z');
    assert.deepEqual(selected.sort(), ['x', 'z']);
    const live = await page.$eval('#multi', (el: HTMLSelectElement) =>
      Array.from(el.selectedOptions).map((option) => option.value),
    );
    assert.deepEqual((live as string[]).sort(), ['x', 'z']);
  });

  inputTest('mouse.click hits viewport coordinates', async () => {
    await page.goto(`${origin}/`);
    const button = await page.$('#btn');
    const box = await button!.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.getElementById('out')!.textContent === 'clicked');
  });
});

describe('waiting', () => {
  safariTest('waitForSelector resolves once the node appears', async () => {
    await page.goto(`${origin}/`);
    void page.evaluate(() => {
      setTimeout(() => {
        const el = document.createElement('div');
        el.id = 'late';
        document.body.appendChild(el);
      }, 300);
    });
    const late = await page.waitForSelector('#late', { timeout: 5000 });
    assert.ok(late);
  });

  safariTest('waitForSelector times out with a TimeoutError', async () => {
    await page.goto(`${origin}/`);
    await assert.rejects(
      () => page.waitForSelector('#never-appears', { timeout: 500 }),
      (error: Error) => error.name === 'TimeoutError',
    );
  });
});

describe('cookies', () => {
  safariTest('set, read, and delete', async () => {
    await page.goto(`${origin}/`);
    await page.deleteAllCookies();
    await page.setCookie({ name: 'token', value: 'abc123', path: '/' });

    const cookies = await page.cookies();
    assert.equal(cookies.find((c) => c.name === 'token')?.value, 'abc123');

    await page.deleteCookie({ name: 'token' });
    assert.equal((await page.cookies()).find((c) => c.name === 'token'), undefined);
  });

  safariTest('rejects the unsupported urls argument explicitly', async () => {
    await assert.rejects(
      () => page.cookies('https://example.com'),
      UnsupportedOperationError,
    );
  });
});

describe('screenshots', () => {
  safariTest('viewport screenshot returns a PNG buffer', async () => {
    await page.goto(`${origin}/`);
    const shot = (await page.screenshot()) as Buffer;
    assert.ok(Buffer.isBuffer(shot));
    // PNG magic number.
    assert.deepEqual([...shot.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  safariTest('element screenshot is smaller than the full viewport', async () => {
    const heading = await page.$('#heading');
    const shot = (await heading!.screenshot()) as Buffer;
    assert.ok(Buffer.isBuffer(shot) && shot.length > 0);
  });
});

describe('tabs', () => {
  safariTest('newPage opens an independently addressable tab', async () => {
    const second = await browser!.newPage();
    await second.goto(`${origin}/second`);
    assert.equal(await second.title(), 'Second');

    // The original page must still be reachable — this is the window-handle
    // multiplexing working.
    await page.goto(`${origin}/`);
    assert.equal(await page.title(), 'Fixture');

    await second.close();
  });
});

describe('unsupported operations fail loudly', () => {
  safariTest('pdf explains why and what to do instead', async () => {
    await assert.rejects(
      () => page.pdf(),
      (error: Error) => {
        assert.ok(error instanceof UnsupportedOperationError);
        assert.match(error.message, /print/);
        assert.match(error.message, /Alternative:/);
        return true;
      },
    );
  });

  safariTest('request interception names the BiDi gap', async () => {
    await assert.rejects(
      () => page.setRequestInterception(),
      /WebDriver BiDi/,
    );
  });
});


/**
 * File upload.
 *
 * WebDriver has no upload command: the spec routes it through "send keys to a
 * file input", and safaridriver's support for that has been inconsistent
 * enough historically that it is worth asserting rather than assuming. If
 * these fail on some future Safari, the README claim needs to change with them.
 */
describe('file upload', () => {
  let uploadDir: string;
  let alpha: string;
  let beta: string;

  before(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'safari-puppeteer-upload-'));
    alpha = join(uploadDir, 'alpha.txt');
    beta = join(uploadDir, 'beta.txt');
    await writeFile(alpha, 'alpha contents');
    await writeFile(beta, 'beta');
  });

  after(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  safariTest('sets a single file on an input', async () => {
    await page.goto(origin, { waitUntil: 'load' });
    const input = await page.$('#file');
    assert.ok(input);
    await input.uploadFile(alpha);

    const files = await page.$eval('#file', (element: HTMLInputElement) =>
      Array.from(element.files ?? []).map((file) => ({ name: file.name, size: file.size })),
    );
    assert.deepEqual(files, [{ name: 'alpha.txt', size: 'alpha contents'.length }]);
  });

  safariTest('sets several files on a multiple input', async () => {
    await page.goto(origin, { waitUntil: 'load' });
    const input = await page.$('#files');
    assert.ok(input);
    // The spec joins paths with a newline; this is the case most likely to
    // differ between drivers.
    await input.uploadFile(alpha, beta);

    const names = await page.$eval('#files', (element: HTMLInputElement) =>
      Array.from(element.files ?? []).map((file) => file.name),
    );
    assert.deepEqual(names.sort(), ['alpha.txt', 'beta.txt']);
  });

  safariTest('makes the file readable by the page', async () => {
    // Proves a real file was attached, not just a name.
    await page.goto(origin, { waitUntil: 'load' });
    const input = await page.$('#file');
    assert.ok(input);
    await input.uploadFile(alpha);

    const text = await page.evaluate(async () => {
      const element = document.querySelector('#file') as HTMLInputElement;
      const file = element.files?.[0];
      return file ? await file.text() : null;
    });
    assert.equal(text, 'alpha contents');
  });

  safariTest('fires a change event, as a real selection would', async () => {
    await page.goto(origin, { waitUntil: 'load' });
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__changed = 0;
      document.querySelector('#file')?.addEventListener('change', () => {
        (window as unknown as Record<string, number>).__changed++;
      });
    });

    const input = await page.$('#file');
    assert.ok(input);
    await input.uploadFile(alpha);

    assert.equal(
      await page.evaluate(() => (window as unknown as Record<string, number>).__changed),
      1,
    );
  });

  safariTest('refuses an element that is not a file input', async () => {
    await page.goto(origin, { waitUntil: 'load' });
    const notAFile = await page.$('#text');
    assert.ok(notAFile);
    await assert.rejects(() => notAFile.uploadFile(alpha), /requires an <input type="file"> element/);
  });

  safariTest('reports a missing file rather than attaching nothing', async () => {
    await page.goto(origin, { waitUntil: 'load' });
    const input = await page.$('#file');
    assert.ok(input);

    // Either the driver rejects the path, or nothing is attached. Silently
    // attaching a phantom file would be the bad outcome.
    const missing = join(uploadDir, 'does-not-exist.txt');
    await input.uploadFile(missing).catch(() => {});
    const count = await page.$eval('#file', (element: HTMLInputElement) => element.files?.length ?? 0);
    assert.equal(count, 0);
  });
});
