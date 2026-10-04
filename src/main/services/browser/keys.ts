/**
 * Keyboard map for real key events.
 *
 * Clicking with a synthetic `element.click()` is not the same thing as a user
 * clicking: it skips pointer events, it does not move focus the way a browser
 * does, and some libraries (drag handles, comboboxes, canvas apps) respond to
 * nothing else. So typing and key presses go through the DevTools protocol as
 * genuine `Input.dispatchKeyEvent` traffic, which needs a key descriptor for
 * every key — including the virtual key code and the physical `code`, both of
 * which a page's own key handlers read.
 */

export interface KeyDescriptor {
  /** The value `KeyboardEvent.key` should carry. */
  key: string
  /** The value `KeyboardEvent.code` should carry. */
  code: string
  /** Legacy `keyCode` / `windowsVirtualKeyCode`. */
  keyCode: number
  /** Text the key inserts. Absent for keys that only act as modifiers. */
  text?: string
  /** True for Shift/Control/Alt/Meta, which never emit a character. */
  modifier: boolean
}

/**
 * Named keys, matching the W3C `UI Events` key/code values.
 *
 * `Enter` is deliberately present twice: browsers report `code: "NumpadEnter"`
 * for the numpad key, and a page that checks `event.code === 'Enter'` — which
 * plenty do — must still receive it.
 */
const NAMED: Record<string, KeyDescriptor> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifier: false },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t', modifier: false },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27, modifier: false },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, modifier: false },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46, modifier: false },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45, modifier: false },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ', modifier: false },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, modifier: false },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, modifier: false },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, modifier: false },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, modifier: false },
  Home: { key: 'Home', code: 'Home', keyCode: 36, modifier: false },
  End: { key: 'End', code: 'End', keyCode: 35, modifier: false },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33, modifier: false },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34, modifier: false },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifier: true },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, modifier: true },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, modifier: true },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, modifier: true },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20, modifier: true }
}

for (let n = 1; n <= 12; n += 1) {
  NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n, modifier: false }
}

/** Aliases an agent is likely to reach for instead of the W3C name. */
const ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  spacebar: 'Space',
  space: 'Space',
  del: 'Delete',
  backspace: 'Backspace',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
  shift: 'Shift',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta'
}

const LETTER_CODES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const DIGIT_CODES = '0123456789'.split('')
const PUNCTUATION: Record<string, string> = {
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '`': 'Backquote'
}

/**
 * Symbols a US layout reaches with Shift on the number row.
 *
 * Without this, typing an email address sends `code: ''` for `@`, and any page
 * that switches behaviour on `event.code` silently takes a different branch.
 */
const SHIFTED_DIGITS: Record<string, string> = {
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0'
}

const SHIFTED_PUNCTUATION: Record<string, string> = {
  _: 'Minus',
  '+': 'Equal',
  '{': 'BracketLeft',
  '}': 'BracketRight',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
  '~': 'Backquote'
}

/**
 * Descriptor for a single printable character.
 *
 * `shifted` matters for the reported `key`: typing `A` without holding Shift
 * must report `key: 'a'` with `text: 'A'`, while the `P` in `Ctrl+Shift+P` must
 * report `key: 'P'` because Shift really is held for that event.
 */
function describeCharacter(char: string, shifted = false): KeyDescriptor {
  const upper = char.toUpperCase()
  const letterIndex = LETTER_CODES.indexOf(upper)
  if (letterIndex >= 0) {
    const isUpper = char === upper
    return {
      key: shifted ? char : isUpper ? char.toLowerCase() : char,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: char,
      modifier: false
    }
  }
  const digitIndex = DIGIT_CODES.indexOf(char)
  if (digitIndex >= 0) {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char, modifier: false }
  }
  return {
    key: char,
    code: PUNCTUATION[char] ?? SHIFTED_PUNCTUATION[char] ?? SHIFTED_DIGITS[char] ?? '',
    keyCode: shiftedDigitKeyCode(char) ?? char.toUpperCase().charCodeAt(0),
    text: char,
    modifier: false
  }
}

/**
 * Virtual key code for a symbol typed with Shift on the number row.
 *
 * The page's `keydown` handler compares `keyCode` against the *unshifted*
 * physical key, so `@` is reported as 50 (`2`), not 64 (`@`).
 */
function shiftedDigitKeyCode(char: string): number | undefined {
  const code = SHIFTED_DIGITS[char]
  if (!code) return undefined
  return code.slice('Digit'.length).charCodeAt(0)
}

export interface KeyParse {
  ok: boolean
  descriptor?: KeyDescriptor
  /** Chords such as `Ctrl+S` expand to several presses, in order. */
  sequence?: KeyDescriptor[]
  error?: string
}

/**
 * Resolve one key name or a `Ctrl+Shift+P`-style chord into CDP descriptors.
 *
 * Chords are not a convenience: the shortcuts that matter in a dev workflow
 * (save, reload, open devtools) are chords, and dispatching only the final key
 * would silently type a letter instead.
 */
export function describeKey(input: string): KeyParse {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, error: 'No key given.' }

  if (!raw.includes('+')) return resolveSingle(raw)

  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return { ok: false, error: `Not a key: ${input}` }

  const modifiers: KeyDescriptor[] = []
  let finalKey = ''
  for (const part of parts) {
    const canonical = ALIASES[part.toLowerCase()] ?? part
    const descriptor = NAMED[canonical]
    if (descriptor?.modifier) {
      modifiers.push(descriptor)
    } else {
      finalKey = canonical
    }
  }

  if (!finalKey) return { ok: false, error: `Not a key chord: ${input}` }

  const shifted = modifiers.some((m) => modifierBit(m) === MODIFIER_BITS.shift)
  const target = resolveSingle(finalKey, shifted)
  if (!target.ok) return target
  const descriptor = target.descriptor
  if (!descriptor) return target
  return { ok: true, sequence: [...modifiers, descriptor] }
}

function resolveSingle(name: string, shifted = false): KeyParse {
  const canonical = ALIASES[name.toLowerCase()] ?? name
  const named = NAMED[canonical]
  if (named) return { ok: true, descriptor: named }

  const characters = [...name]
  const only = characters[0]
  if (characters.length === 1 && only) return { ok: true, descriptor: describeCharacter(only, shifted) }
  if (characters.length > 1) {
    // "abc" typed as a key name means those three characters in order.
    return { ok: true, sequence: characters.map((char) => describeCharacter(char, shifted)) }
  }
  return { ok: false, error: `Unknown key: ${name}` }
}

/** Bitmask CDP expects alongside a dispatched key event. */
export const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8
} as const

/** The bit a single key contributes to the modifier mask, or 0. */
export function modifierBit(descriptor: KeyDescriptor): number {
  if (descriptor.code.startsWith('Alt')) return MODIFIER_BITS.alt
  if (descriptor.code.startsWith('Control')) return MODIFIER_BITS.ctrl
  if (descriptor.code.startsWith('Meta')) return MODIFIER_BITS.meta
  if (descriptor.code.startsWith('Shift')) return MODIFIER_BITS.shift
  return 0
}

export function modifiersMask(descriptors: KeyDescriptor[]): number {
  let mask = 0
  for (const d of descriptors) mask |= modifierBit(d)
  return mask
}