/**
 * Verify the published tarball actually works.
 *
 * `npm pack` + install into a scratch directory + import the built entry point.
 * This catches the failure modes that a source-tree test cannot:
 *
 *   - `files` omitting something the entry point needs
 *   - `.ts` import specifiers surviving into dist (the source uses them, and
 *     `rewriteRelativeImportExtensions` is what turns them into `.js`)
 *   - broken `exports` / `types` wiring
 *   - accidentally shipping node_modules, tests, or scratch files
 *
 * Run: npm run test:package
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'safari-puppeteer-pack-'));
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`✗ ${name}\n    ${error.message.split('\n').join('\n    ')}`);
  }
}

try {
  // --- Pack -----------------------------------------------------------------
  const packJson = execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [meta] = JSON.parse(packJson);
  const tarball = join(scratch, meta.filename);
  const shipped = meta.files.map((file) => file.path);

  console.log(
    `\npacked ${meta.filename} — ${meta.entryCount} files, ` +
      `${(meta.unpackedSize / 1024).toFixed(0)} kB unpacked\n`,
  );

  check('ships the built entry point', () => {
    assert.ok(shipped.includes('dist/index.js'), 'dist/index.js missing from tarball');
    assert.ok(shipped.includes('dist/index.d.ts'), 'dist/index.d.ts missing from tarball');
  });

  check('ships README and LICENSE', () => {
    assert.ok(shipped.includes('README.md'), 'README.md missing');
    assert.ok(shipped.includes('LICENSE'), 'LICENSE missing');
  });

  check('does not ship sources, tests, or scratch files', () => {
    const unwanted = shipped.filter(
      (file) =>
        file.startsWith('src/') ||
        file.startsWith('test/') ||
        file.startsWith('examples/') ||
        file.startsWith('scripts/') ||
        file.startsWith('node_modules/') ||
        file.endsWith('.png') ||
        file.endsWith('.tsbuildinfo'),
    );
    assert.deepEqual(unwanted, [], `unexpected files in tarball: ${unwanted.join(', ')}`);
  });

  check('no .ts import specifiers leaked into dist', () => {
    // The source imports `./foo.ts`; tsc must rewrite those to `./foo.js`.
    // If this regresses, the package explodes on first import.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/from\s+['"]\.[^'"]*\.ts['"]/.test(text)) offenders.push(path);
        }
      }
    };
    walk(join(root, 'dist'));
    assert.deepEqual(offenders, [], `files still importing .ts: ${offenders.join(', ')}`);
  });

  // --- Install and import ---------------------------------------------------
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const entry = join(consumer, 'node_modules', 'safari-puppeteer', 'dist', 'index.js');
  const mod = await import(pathToFileURL(entry).href);

  check('named exports are present', () => {
    for (const name of [
      'launch',
      'connect',
      'Browser',
      'Page',
      'JSHandle',
      'ElementHandle',
      'Keyboard',
      'Mouse',
      'SafariApp',
      'WebDriverClient',
      'SafariDriverProcess',
      'TimeoutError',
      'UnsupportedOperationError',
      'WebDriverError',
    ]) {
      assert.ok(name in mod, `missing export: ${name}`);
    }
  });

  check('default export exposes launch/connect', () => {
    assert.equal(typeof mod.default.launch, 'function');
    assert.equal(typeof mod.default.connect, 'function');
  });

  check('the package resolves by bare specifier', async () => {
    // Proves `exports` is wired correctly, not just the deep path.
    const byName = execFileSync(
      process.execPath,
      ['-e', "import('safari-puppeteer').then(m => console.log(typeof m.launch))"],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(byName.trim(), 'function');
  });

  check('unsupported APIs still reject with guidance', async () => {
    // A cheap end-to-end proof that error classes survived the build.
    assert.equal(typeof mod.UnsupportedOperationError, 'function');
    const error = new mod.UnsupportedOperationError('x()', 'because', 'do y');
    assert.match(error.message, /Reason: because/);
    assert.match(error.message, /Alternative: do y/);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nPackage looks publishable.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
