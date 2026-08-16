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

/**
 * Environment for the nested npm calls.
 *
 * npm exports its own config into lifecycle scripts, so running this from
 * `prepublishOnly` under `npm publish --dry-run` sets npm_config_dry_run=true
 * — which the nested `npm install` inherits and quietly turns into a no-op,
 * leaving nothing to import. Stripping those keys makes this behave the same
 * whether it is run by hand or by the publish lifecycle.
 */
function npmEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_config_dry_run') || key.startsWith('npm_lifecycle_')) {
      delete env[key];
    }
  }
  return env;
}

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
    env: npmEnv(),
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

  check('ships the doctor CLI', () => {
    // The setup this library needs is all OS-level toggles, so the tool that
    // diagnoses them has to reach whoever installed the package.
    assert.ok(shipped.includes('dist/cli/index.js'), 'dist/cli/index.js missing from tarball');
    assert.ok(shipped.includes('dist/cli/doctor.js'), 'dist/cli/doctor.js missing from tarball');

    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.bin?.['safari-puppeteer'], './dist/cli/index.js');

    // Without the shebang npm's shim cannot exec it.
    const cli = readFileSync(join(root, 'dist', 'cli', 'index.js'), 'utf8');
    assert.ok(cli.startsWith('#!/usr/bin/env node'), 'CLI is missing its shebang');
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
    env: npmEnv(),
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
      { cwd: consumer, encoding: 'utf8', env: npmEnv() },
    );
    assert.equal(byName.trim(), 'function');
  });

  check('declares @types/node as a runtime dependency', () => {
    // The public types reference `Buffer` and extend `EventEmitter`, so the
    // declarations do not stand alone. Shipping it as a real dependency is what
    // lets a consumer compile without installing it themselves.
    const manifest = JSON.parse(
      readFileSync(join(consumer, 'node_modules', 'safari-puppeteer', 'package.json'), 'utf8'),
    );
    assert.ok(
      manifest.dependencies?.['@types/node'],
      '@types/node must be a dependency, not a devDependency',
    );
  });

  check('a TypeScript consumer compiles without installing @types/node', () => {
    // The end-to-end proof of the check above, and a guard against declaration
    // emit regressing (bad `.ts` specifiers surface here too).
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['probe.ts'],
      }),
    );
    writeFileSync(
      join(consumer, 'probe.ts'),
      [
        "import { launch, type Viewport } from 'safari-puppeteer';",
        'const viewport: Viewport = { width: 800, height: 600 };',
        'export async function probe(): Promise<number> {',
        '  const browser = await launch({ defaultViewport: viewport });',
        '  const [page] = await browser.pages();',
        '  if (!page) throw new Error("no page");',
        '  const shot: Buffer = await page.screenshot();',
        '  const b64: string = await page.screenshot({ encoding: "base64" });',
        '  await browser.close();',
        '  return shot.length + b64.length;',
        '}',
      ].join('\n'),
    );

    // Use this repo's TypeScript; the consumer only has the package itself.
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], {
      cwd: consumer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  check('the installed CLI is executable by name', () => {
    // npm links bin entries into node_modules/.bin and sets the exec bit; this
    // is the only way to prove `npx safari-puppeteer doctor` will work.
    const version = execFileSync(join(consumer, 'node_modules', '.bin', 'safari-puppeteer'), ['--version'], {
      cwd: consumer,
      encoding: 'utf8',
      env: npmEnv(),
    });
    assert.match(version.trim(), /^\d+\.\d+\.\d+/);

    const help = execFileSync(join(consumer, 'node_modules', '.bin', 'safari-puppeteer'), ['--help'], {
      cwd: consumer,
      encoding: 'utf8',
      env: npmEnv(),
    });
    assert.match(help, /doctor/);
    assert.match(help, /safaridriver --enable/);
  });

  check('unsupported APIs still reject with guidance', async () => {
    // A cheap end-to-end proof that error classes survived the build.
    assert.equal(typeof mod.UnsupportedOperationError, 'function');
    const error = new mod.UnsupportedOperationError('x()', 'because', 'do y');
    assert.match(error.message, /Reason: because/);
    assert.match(error.message, /Alternative: do y/);
  });

  check('the MCP channel is exported and degrades with instructions', async () => {
    for (const name of ['SafariMcp', 'McpTransport', 'isMcpSupported', 'McpError']) {
      assert.equal(typeof mod[name], 'function', `${name} must be exported`);
    }
    assert.equal(mod.SAFARI_MCP_TOOLS.length, 17);
    assert.match(mod.MCP_UNAVAILABLE_HINT, /safari-technology-preview/);

    // A driver that cannot serve MCP must be reported, not assumed.
    assert.equal(await mod.isMcpSupported('/nonexistent/safaridriver'), false);
  });

  check('both backends ship and declare their capabilities', async () => {
    for (const name of ['WebDriverBackend', 'McpBackend', 'WebDriverSession', 'McpSession']) {
      assert.equal(typeof mod[name], 'function', `${name} must be exported`);
    }

    // Constructed with nulls: supports() must be answerable without a live
    // connection, since launch() and Page consult it before doing anything.
    const webdriver = new mod.WebDriverBackend(null, 'handle');
    const mcp = new mod.McpBackend(null, 'handle');

    assert.equal(webdriver.name, 'webdriver');
    assert.equal(mcp.name, 'mcp');

    assert.ok(webdriver.supports('elementHandles'));
    assert.ok(webdriver.supports('cookies'));
    assert.equal(webdriver.supports('networkInspection'), false);

    assert.ok(mcp.supports('networkInspection'), 'the MCP backend exists for this');
    assert.equal(mcp.supports('elementHandles'), false);
    assert.equal(mcp.supports('cookies'), false);
  });

  check("launch({ backend: 'mcp' }) fails with instructions when unavailable", async () => {
    await assert.rejects(
      () => mod.launch({ backend: 'mcp', safaridriverPath: '/nonexistent/safaridriver' }),
      (error) => {
        assert.match(error.message, /does not support --mcp/);
        assert.match(error.message, /safari-technology-preview/);
        return true;
      },
    );
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nPackage looks publishable.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
