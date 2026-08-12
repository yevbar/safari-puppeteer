/**
 * Unit tests — no Safari required.
 *
 * These cover the pure translation logic: key mapping, argument serialization,
 * script assembly, and WebDriver error decoding. Anything needing a live
 * browser lives in integration.test.ts.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, it } from 'node:test';

import { ExecutionContext, serializeArgs } from '../src/api/ExecutionContext.ts';
import { MODIFIER_KEYS, resolveKey, WEBDRIVER_KEYS } from '../src/api/USKeyboardLayout.ts';
import { SafariPuppeteerError, WebDriverError } from '../src/common/errors.ts';
import { poll } from '../src/common/util.ts';
import { ELEMENT_KEY, isElementRef, WebDriverClient } from '../src/webdriver/client.ts';

describe('USKeyboardLayout', () => {
  it('maps named keys to the W3C private-use codepoints', () => {
    assert.equal(resolveKey('Backspace').codePointAt(0), 0xe003);
    assert.equal(resolveKey('Enter').codePointAt(0), 0xe007);
    assert.equal(resolveKey('ArrowLeft').codePointAt(0), 0xe012);
    assert.equal(resolveKey('F12').codePointAt(0), 0xe03c);
    assert.equal(resolveKey('Meta').codePointAt(0), 0xe03d);
  });

  it('gives left and right modifiers distinct codepoints', () => {
    assert.notEqual(resolveKey('ShiftLeft'), resolveKey('ShiftRight'));
    assert.equal(resolveKey('ShiftRight').codePointAt(0), 0xe050);
  });

  it('passes printable single characters through unchanged', () => {
    assert.equal(resolveKey('a'), 'a');
    assert.equal(resolveKey('Z'), 'Z');
    assert.equal(resolveKey('7'), '7');
    assert.equal(resolveKey('€'), '€');
  });

  it('accepts KeyA / Digit1 style codes', () => {
    assert.equal(resolveKey('KeyA'), 'a');
    assert.equal(resolveKey('Digit1'), '1');
  });

  it('throws a useful message for unknown keys', () => {
    assert.throws(() => resolveKey('NotARealKey'), /Unknown key: "NotARealKey"/);
  });

  it('treats every modifier name as resolvable', () => {
    for (const key of MODIFIER_KEYS) {
      assert.equal(typeof resolveKey(key), 'string', `${key} should resolve`);
    }
  });

  it('has no accidental duplicate mappings for distinct physical keys', () => {
    // ArrowUp and ArrowDown colliding would be a silent, miserable bug.
    assert.notEqual(WEBDRIVER_KEYS['ArrowUp'], WEBDRIVER_KEYS['ArrowDown']);
    assert.notEqual(WEBDRIVER_KEYS['PageUp'], WEBDRIVER_KEYS['PageDown']);
  });
});

describe('serializeArgs', () => {
  it('passes JSON-safe values through', () => {
    assert.deepEqual(serializeArgs([1, 'two', true, null, { a: [1, 2] }]), [
      1,
      'two',
      true,
      null,
      { a: [1, 2] },
    ]);
  });

  it('converts undefined to null, since JSON has no undefined', () => {
    assert.deepEqual(serializeArgs([undefined]), [null]);
  });

  it('rejects functions with an actionable message', () => {
    assert.throws(() => serializeArgs([() => 1]), /Functions cannot be passed/);
  });

  it('rejects BigInt', () => {
    assert.throws(() => serializeArgs([1n]), SafariPuppeteerError);
  });

  it('unwraps objects that know how to serialize themselves', () => {
    const handleLike = { toScriptArg: () => ({ marker: 42 }) };
    assert.deepEqual(serializeArgs([handleLike]), [{ marker: 42 }]);
  });
});

describe('ExecutionContext argument tunnelling', () => {
  it('wraps registry ids in a marker object', () => {
    const arg = ExecutionContext.handleArg(7) as Record<string, number>;
    assert.equal(Object.values(arg)[0], 7);
  });

  it('wraps element ids in a W3C element reference', () => {
    const arg = ExecutionContext.elementArg('abc-123') as Record<string, string>;
    assert.equal(arg[ELEMENT_KEY], 'abc-123');
    assert.ok(isElementRef(arg));
  });
});

describe('WebDriverClient error decoding', () => {
  let server: Server;
  let baseUrl: string;
  /** Set per-test to control what the fake driver returns. */
  let respond: (url: string) => { status: number; body: unknown };

  const started = new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const { status, body } = respond(req.url ?? '');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });

  after(() => server.close());

  it('unwraps the W3C `value` envelope on success', async () => {
    await started;
    respond = () => ({ status: 200, body: { value: 'https://example.com/' } });
    const client = new WebDriverClient(baseUrl);
    await client.attachSession('fake-session').catch(() => {});
    assert.equal(await client.getCurrentUrl(), 'https://example.com/');
  });

  it('turns a W3C error payload into a WebDriverError with its code', async () => {
    await started;
    respond = () => ({
      status: 404,
      body: { value: { error: 'no such element', message: 'Unable to locate element' } },
    });
    const client = new WebDriverClient(baseUrl);
    await assert.rejects(
      () => client.send('GET', '/session/x/element/y/text'),
      (error: unknown) => {
        assert.ok(error instanceof WebDriverError);
        assert.equal(error.code, 'no such element');
        assert.match(error.message, /Unable to locate element/);
        return true;
      },
    );
  });

  it('reports a clear error when the driver is unreachable', async () => {
    const client = new WebDriverClient('http://127.0.0.1:1');
    await assert.rejects(() => client.status(), /Failed to reach safaridriver/);
  });

  it('requires a session for session-scoped calls', async () => {
    const client = new WebDriverClient(baseUrl);
    await assert.rejects(() => client.getTitle(), /No active safaridriver session/);
  });
});

describe('poll', () => {
  it('returns the first truthy value', async () => {
    let calls = 0;
    const value = await poll(
      async () => (++calls < 3 ? null : 'ready'),
      { timeout: 2000, interval: 5, message: 'x' },
    );
    assert.equal(value, 'ready');
    assert.equal(calls, 3);
  });

  it('throws a TimeoutError naming what it was waiting for', async () => {
    await assert.rejects(
      () => poll(async () => null, { timeout: 60, interval: 10, message: 'Waiting for widget' }),
      /Waiting for widget \(timeout 60ms\)/,
    );
  });

  it('surfaces the last thrown error in the timeout message', async () => {
    await assert.rejects(
      () =>
        poll(
          async () => {
            throw new Error('stale element');
          },
          { timeout: 60, interval: 10, message: 'Waiting' },
        ),
      /Last error: stale element/,
    );
  });
});
