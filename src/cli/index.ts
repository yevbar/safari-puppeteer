#!/usr/bin/env node
/**
 * The `safari-puppeteer` command.
 *
 * This exists because every prerequisite of this library is an OS-level trust
 * decision — enabling the driver, allowing Remote Automation, granting
 * Automation permission, keeping the screen unlocked — and none of them can be
 * fixed from inside a script. Shipping the diagnosis with the package means
 * whoever installed it can find out what is missing, rather than reading a
 * session-creation failure and guessing.
 */
import { runDoctor } from './doctor.ts';

const USAGE = `safari-puppeteer — control local Safari with the Puppeteer API

Usage:
  npx safari-puppeteer doctor     Check the environment and print exact fixes
  npx safari-puppeteer --version  Print the package version
  npx safari-puppeteer --help     Show this message

Setup, once per machine (neither can be scripted):
  safaridriver --enable
  Safari > Settings > Advanced > "Show features for web developers"
  Safari > Develop > "Allow Remote Automation"
`;

async function version(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const manifest = new URL('../../package.json', import.meta.url);
  try {
    const { version: value } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
    return value;
  } catch {
    return 'unknown';
  }
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  switch (command) {
    case 'doctor':
      return runDoctor();

    case '--version':
    case '-v':
      console.log(await version());
      return 0;

    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE);
      // No command is a request for help, not a failure.
      return 0;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
