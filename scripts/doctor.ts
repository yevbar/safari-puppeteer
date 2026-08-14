/**
 * Environment check for safari-puppeteer.
 *
 * Run: npm run doctor
 *
 * Every failure prints the exact command or setting that fixes it, so this can
 * be run by an agent as a first step and acted on without asking a human.
 * Exit code 0 means the environment can drive Safari.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';

const execFileAsync = promisify(execFile);

type Status = 'pass' | 'fail' | 'warn';

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const results: CheckResult[] = [];

function record(name: string, status: Status, detail: string, fix?: string): void {
  results.push({ name, status, detail, fix });
}

async function checkPlatform(): Promise<void> {
  if (platform() !== 'darwin') {
    record('Platform', 'fail', `${platform()} — Safari automation requires macOS.`);
    return;
  }
  const { stdout } = await execFileAsync('/usr/bin/sw_vers', ['-productVersion']);
  record('Platform', 'pass', `macOS ${stdout.trim()}`);
}

async function checkSafari(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/defaults', [
      'read',
      '/Applications/Safari.app/Contents/Info.plist',
      'CFBundleShortVersionString',
    ]);
    const version = stdout.trim();
    record('Safari', 'pass', `version ${version}`);

    const major = Number.parseInt(version, 10);
    if (Number.isFinite(major) && major < 27) {
      record(
        'Full-page screenshots',
        'warn',
        `Safari ${version} clips /screenshot to the viewport.`,
        'safari-puppeteer emulates fullPage by resizing the window. Very tall pages may still be truncated. Safari 27 / STP 247 fixed this natively.',
      );
    }
  } catch {
    record('Safari', 'fail', 'Safari.app not found in /Applications.');
  }
}

async function checkSafariDriver(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/safaridriver', ['--version']);
    record('safaridriver', 'pass', stdout.trim().split('\n')[0] ?? 'present');
  } catch (cause) {
    record(
      'safaridriver',
      'fail',
      `Cannot run /usr/bin/safaridriver: ${(cause as Error).message}`,
      'Install Safari, or use Safari Technology Preview:\n' +
        "  launch({ safaridriverPath: '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver' })",
    );
  }
}

/**
 * The only reliable test for Remote Automation is to actually create a session,
 * so that is what we do — briefly.
 */
async function checkRemoteAutomation(): Promise<void> {
  const { SafariDriverProcess } = await import('../src/webdriver/safaridriver.ts');
  const { WebDriverClient } = await import('../src/webdriver/client.ts');

  let driver: InstanceType<typeof SafariDriverProcess> | null = null;
  try {
    driver = await SafariDriverProcess.start({ startTimeout: 15_000 });
  } catch (cause) {
    record(
      'Remote Automation',
      'fail',
      `safaridriver did not start: ${(cause as Error).message}`,
      'Run:  safaridriver --enable\nThen in Safari: Settings > Advanced > "Show features for web developers",\nand Develop > "Allow Remote Automation".',
    );
    return;
  }

  try {
    const client = new WebDriverClient(driver.url);
    await client.newSession({ browserName: 'safari' });
    const handle = await client.getWindowHandle();
    record('Remote Automation', 'pass', `session created, window handle ${handle.slice(0, 12)}…`);
    await client.deleteSession();
  } catch (cause) {
    record(
      'Remote Automation',
      'fail',
      `Session creation failed: ${(cause as Error).message}`,
      'Run:  safaridriver --enable\nThen in Safari: Develop > "Allow Remote Automation".\nAlso close any other automated Safari session — safaridriver serves one at a time.',
    );
  } finally {
    await driver.kill();
  }
}

/**
 * A locked screen breaks native input specifically, and does so silently, so it
 * is worth reporting even though everything else will look healthy.
 */
async function checkScreenLock(): Promise<void> {
  const { isScreenLocked, SCREEN_LOCKED_HINT } = await import('../src/common/macos.ts');
  const locked = await isScreenLocked();
  record(
    'Screen lock',
    locked ? 'warn' : 'pass',
    locked ? 'screen is LOCKED — pointer events (clicks, hover, tap) will do nothing' : 'screen is unlocked',
    locked ? SCREEN_LOCKED_HINT : undefined,
  );
}

/**
 * The MCP channel is optional and preview-only, so its absence is a note
 * rather than a warning.
 */
async function checkMcp(): Promise<void> {
  const { isMcpSupported, MCP_UNAVAILABLE_HINT } = await import('../src/mcp/SafariMcp.ts');
  const { DEFAULT_SAFARIDRIVER, TECH_PREVIEW_SAFARIDRIVER } = await import(
    '../src/webdriver/safaridriver.ts'
  );

  const supported: string[] = [];
  for (const binary of [DEFAULT_SAFARIDRIVER, TECH_PREVIEW_SAFARIDRIVER]) {
    if (await isMcpSupported(binary)) supported.push(binary);
  }

  if (supported.length === 0) {
    record(
      'MCP channel (optional)',
      'warn',
      'no safaridriver on this machine supports --mcp',
      MCP_UNAVAILABLE_HINT,
    );
    return;
  }

  const usesPreview = supported.every((binary) => binary === TECH_PREVIEW_SAFARIDRIVER);
  record(
    'MCP channel (optional)',
    'pass',
    `--mcp supported by ${supported.join(', ')}`,
    usesPreview
      ? 'Only Technology Preview supports it, so pass both options together:\n' +
        `  launch({ mcp: true, safaridriverPath: '${TECH_PREVIEW_SAFARIDRIVER}' })\n` +
        'Remote automation must be enabled in Technology Preview separately from Safari.'
      : undefined,
  );
}

/** AppleScript is optional; only some features need it. */
async function checkAppleScript(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to return (exists (processes where name is "Safari"))'],
      { timeout: 15_000 },
    );
    record('AppleScript bridge', 'pass', `osascript reachable (Safari running: ${stdout.trim()})`);
  } catch (cause) {
    record(
      'AppleScript bridge',
      'warn',
      `osascript failed: ${(cause as Error).message}`,
      'Grant Automation permission: System Settings > Privacy & Security > Automation >\n' +
        'enable Safari + System Events under your terminal.\n' +
        'Only the page.safari / SafariApp features need this; WebDriver works without it.',
    );
  }
}

/** `do JavaScript` needs a separate Safari setting from Remote Automation. */
async function checkAppleEventsJavaScript(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/defaults',
      ['read', 'com.apple.Safari', 'AllowJavaScriptFromAppleEvents'],
      { timeout: 10_000 },
    );
    const enabled = stdout.trim() === '1';
    record(
      'JavaScript from Apple Events',
      enabled ? 'pass' : 'warn',
      enabled ? 'enabled' : 'disabled',
      enabled
        ? undefined
        : 'Only needed for SafariApp.doJavaScript(). Enable in Safari:\n' +
          'Develop > "Allow JavaScript from Apple Events".\n' +
          'Prefer page.evaluate(), which uses WebDriver and needs no such setting.',
    );
  } catch {
    record(
      'JavaScript from Apple Events',
      'warn',
      'setting not present (defaults to disabled)',
      'Only needed for SafariApp.doJavaScript(). Prefer page.evaluate().',
    );
  }
}

const ICONS: Record<Status, string> = { pass: '✓', fail: '✗', warn: '!' };

async function main(): Promise<void> {
  console.log('safari-puppeteer doctor\n');

  await checkPlatform();
  await checkSafari();
  await checkSafariDriver();
  await checkScreenLock();
  await checkMcp();
  await checkAppleScript();
  await checkAppleEventsJavaScript();

  // Only worth launching a real session if the basics passed.
  if (!results.some((r) => r.status === 'fail')) {
    await checkRemoteAutomation();
  }

  for (const result of results) {
    console.log(`${ICONS[result.status]} ${result.name}: ${result.detail}`);
    if (result.fix) {
      console.log(result.fix.split('\n').map((line) => `    ${line}`).join('\n'));
    }
  }

  const failures = results.filter((r) => r.status === 'fail');
  console.log(
    `\n${results.filter((r) => r.status === 'pass').length} passed, ` +
      `${results.filter((r) => r.status === 'warn').length} warnings, ` +
      `${failures.length} failed.`,
  );

  if (failures.length > 0) {
    console.log('\nsafari-puppeteer cannot drive Safari until the failures above are fixed.');
    process.exitCode = 1;
    return;
  }
  console.log('\nEnvironment is ready.');
}

await main();
