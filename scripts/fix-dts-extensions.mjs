/**
 * Rewrite relative `.ts` import specifiers to `.js` in emitted declarations.
 *
 * Why this exists: the source deliberately uses `.ts` specifiers so it runs
 * directly under `node --experimental-strip-types` (no build step for tests,
 * examples, or the doctor). `rewriteRelativeImportExtensions` handles that for
 * the emitted JavaScript, but as of TypeScript 5.9 it does *not* rewrite
 * declaration files — so `dist/**\/*.d.ts` ships with `from './Page.ts'`,
 * pointing at files that are not in the package. Any TypeScript consumer then
 * fails to resolve the types.
 *
 * Run automatically by `npm run build`. `npm run test:package` asserts that no
 * `.ts` specifiers survive, so this cannot silently regress.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');

/** Matches the specifier in `from './x.ts'` / `import('./x.ts')`, quotes either style. */
const RELATIVE_TS = /(from\s*|import\s*\(\s*)(['"])(\.[^'"]*)\.ts\2/g;

let filesChanged = 0;
let specifiersChanged = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;

    const before = readFileSync(path, 'utf8');
    let count = 0;
    const after = before.replace(RELATIVE_TS, (_match, prefix, quote, specifier) => {
      count++;
      return `${prefix}${quote}${specifier}.js${quote}`;
    });

    if (count > 0) {
      writeFileSync(path, after);
      filesChanged++;
      specifiersChanged += count;
    }
  }
}

walk(dist);
console.log(
  `fix-dts-extensions: rewrote ${specifiersChanged} specifier(s) across ${filesChanged} declaration file(s)`,
);
