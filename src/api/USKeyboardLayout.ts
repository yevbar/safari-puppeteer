/**
 * Mapping from Puppeteer/DOM key names to the Unicode Private Use Area
 * codepoints the W3C WebDriver spec assigns to non-printable keys.
 *
 * Spec: https://w3c.github.io/webdriver/#keyboard-actions
 *
 * Puppeteer's `page.keyboard.press('ArrowLeft')` uses DOM `KeyboardEvent.key`
 * names, so we translate those into the codepoints safaridriver expects.
 *
 * The table stores **numeric** codepoints rather than string literals on
 * purpose: the characters are invisible, so literals would be impossible to
 * review, diff, or spot-check for off-by-one errors.
 */
const KEY_CODEPOINTS: Record<string, number> = {
  Unidentified: 0xe000,
  Cancel: 0xe001,
  Help: 0xe002,
  Backspace: 0xe003,
  Tab: 0xe004,
  Clear: 0xe005,
  Return: 0xe006,
  Enter: 0xe007,
  Shift: 0xe008,
  ShiftLeft: 0xe008,
  Control: 0xe009,
  ControlLeft: 0xe009,
  Alt: 0xe00a,
  AltLeft: 0xe00a,
  Pause: 0xe00b,
  Escape: 0xe00c,
  Space: 0xe00d,
  ' ': 0xe00d,
  PageUp: 0xe00e,
  PageDown: 0xe00f,
  End: 0xe010,
  Home: 0xe011,
  ArrowLeft: 0xe012,
  ArrowUp: 0xe013,
  ArrowRight: 0xe014,
  ArrowDown: 0xe015,
  Insert: 0xe016,
  Delete: 0xe017,
  Semicolon: 0xe018,
  Equal: 0xe019,

  Numpad0: 0xe01a,
  Numpad1: 0xe01b,
  Numpad2: 0xe01c,
  Numpad3: 0xe01d,
  Numpad4: 0xe01e,
  Numpad5: 0xe01f,
  Numpad6: 0xe020,
  Numpad7: 0xe021,
  Numpad8: 0xe022,
  Numpad9: 0xe023,
  NumpadMultiply: 0xe024,
  NumpadAdd: 0xe025,
  NumpadSeparator: 0xe026,
  NumpadSubtract: 0xe027,
  NumpadDecimal: 0xe028,
  NumpadDivide: 0xe029,

  F1: 0xe031,
  F2: 0xe032,
  F3: 0xe033,
  F4: 0xe034,
  F5: 0xe035,
  F6: 0xe036,
  F7: 0xe037,
  F8: 0xe038,
  F9: 0xe039,
  F10: 0xe03a,
  F11: 0xe03b,
  F12: 0xe03c,

  // On macOS the Command key is the primary accelerator; the DOM reports it
  // as `Meta`, and WebDriver assigns it this codepoint.
  Meta: 0xe03d,
  MetaLeft: 0xe03d,
  Command: 0xe03d,

  ZenkakuHankaku: 0xe040,

  // Right-hand modifiers have distinct codepoints so a `down`/`up` pair on
  // `ShiftRight` releases the key it actually pressed.
  ShiftRight: 0xe050,
  ControlRight: 0xe051,
  AltRight: 0xe052,
  MetaRight: 0xe053,

  NumpadPageUp: 0xe054,
  NumpadPageDown: 0xe055,
  NumpadEnd: 0xe056,
  NumpadHome: 0xe057,
  NumpadArrowLeft: 0xe058,
  NumpadArrowUp: 0xe059,
  NumpadArrowRight: 0xe05a,
  NumpadArrowDown: 0xe05b,
  NumpadInsert: 0xe05c,
  NumpadDelete: 0xe05d,
};

/** Key name -> the literal character to put in a WebDriver key action. */
export const WEBDRIVER_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_CODEPOINTS).map(([name, code]) => [name, String.fromCodePoint(code)]),
);

/** Modifier keys, which stay held until explicitly released. */
export const MODIFIER_KEYS = new Set([
  'Alt',
  'AltLeft',
  'AltRight',
  'Control',
  'ControlLeft',
  'ControlRight',
  'Meta',
  'MetaLeft',
  'MetaRight',
  'Command',
  'Shift',
  'ShiftLeft',
  'ShiftRight',
]);

/**
 * Resolve a Puppeteer key name to the character/codepoint to send.
 * Printable single characters pass through unchanged.
 */
export function resolveKey(key: string): string {
  const mapped = WEBDRIVER_KEYS[key];
  if (mapped !== undefined) return mapped;
  if ([...key].length === 1) return key;

  // Puppeteer also accepts `KeyA`/`Digit1` style codes for printable keys.
  const keyMatch = /^Key([A-Z])$/.exec(key);
  if (keyMatch?.[1]) return keyMatch[1].toLowerCase();
  const digitMatch = /^Digit([0-9])$/.exec(key);
  if (digitMatch?.[1]) return digitMatch[1];

  throw new Error(
    `Unknown key: "${key}". Use a DOM KeyboardEvent.key name (e.g. 'ArrowLeft', 'Enter') or a single character.`,
  );
}
