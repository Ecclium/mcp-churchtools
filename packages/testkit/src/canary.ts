/**
 * Canary values for tests: made at run time from random bytes, so that no
 * test file holds a value that looks like a token or an e-mail address, and
 * a detector that finds them in output also after common encodings.
 *
 * @packageDocumentation
 */

import { randomInt } from 'node:crypto';
import { inspect } from 'node:util';

/** The shapes of canary values. */
export type CanaryKind = 'token' | 'email' | 'name' | 'phone';

/**
 * A value that must never appear in output. `cores` are its random parts,
 * the fixed parts such as `@example.org` never count alone, and a piece of a
 * core of at least `minFragment` characters counts as a leak.
 */
export interface Canary {
  /** Shape of the value. */
  readonly kind: CanaryKind;
  /** The whole value. */
  readonly value: string;
  /** The random parts of the value. */
  readonly cores: readonly string[];
  /** Shortest piece of a core that still counts as a leak. */
  readonly minFragment: number;
}

/** One canary of each kind, and all of them as a list. */
export interface CanarySet {
  /** A value shaped like a token, with characters JSON must escape. */
  readonly token: Canary;
  /** An e-mail address at the placeholder domain example.org. */
  readonly email: Canary;
  /** A first and last name with an umlaut. */
  readonly name: Canary;
  /** A phone number that no real number can match. */
  readonly phone: Canary;
  /** All four. */
  readonly all: readonly Canary[];
}

/** How a canary was found. */
export interface CanaryFinding {
  /** Kind of the canary. */
  readonly kind: CanaryKind;
  /** Encoding in which it was found. */
  readonly form: 'raw' | 'json' | 'url' | 'base64' | 'hex' | 'digits';
  /** Whether the whole value, a core or a piece of a core was found. */
  readonly part: 'value' | 'core' | 'fragment';
  /** Whether it was found only after removing whitespace and line joins. */
  readonly squeezed: boolean;
}

const alphanumeric =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const lowercase = 'abcdefghijklmnopqrstuvwxyz';
const lowerAlphanumeric = 'abcdefghijklmnopqrstuvwxyz0123456789';
const digits = '0123456789';
// Characters JSON, URLs and shells treat specially, so that an encoding of
// the token differs from the token itself. It ends in '#', so no backslash
// stands right before a core and makes an escape such as \n out of it.
const specialBlock = String.raw`"\'<>&%{}[]()$#`;
const umlauts = 'äöüé';

const randomText = (alphabet: string, length: number): string => {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += alphabet.charAt(randomInt(alphabet.length));
  }
  return text;
};

const fold = (text: string): string => text.normalize('NFC').toLowerCase();

const capitalised = (length: number): string =>
  randomText(lowercase, 1).toUpperCase() + randomText(lowercase, length - 1);

/**
 * Makes one canary of the given kind.
 *
 * @param kind - The shape of the value.
 * @returns A new canary with fresh random parts.
 * @example
 * ```ts
 * const token = makeCanary('token');
 * const secret = new Secret(token.value);
 * ```
 */
export function makeCanary(kind: CanaryKind): Canary {
  switch (kind) {
    case 'token': {
      const cores = [
        randomText(alphanumeric, 24),
        randomText(alphanumeric, 24),
      ];
      const value = `CANARY${cores[0] ?? ''}${specialBlock}${cores[1] ?? ''}`;
      return Object.freeze({
        kind,
        value,
        cores: Object.freeze(cores),
        minFragment: 8,
      });
    }
    case 'email': {
      const cores = [
        randomText(lowerAlphanumeric, 10),
        randomText(lowerAlphanumeric, 10),
      ];
      const value = `${cores[0] ?? ''}.${cores[1] ?? ''}+${randomText(lowerAlphanumeric, 4)}@example.org`;
      return Object.freeze({
        kind,
        value,
        cores: Object.freeze(cores),
        minFragment: 8,
      });
    }
    case 'name': {
      const family = capitalised(11) + randomText(umlauts, 1);
      const cores = [capitalised(12), family];
      const value = `${cores[0] ?? ''} ${family}`;
      return Object.freeze({
        kind,
        value,
        cores: Object.freeze(cores),
        minFragment: 12,
      });
    }
    case 'phone': {
      const core = randomText(digits, 12);
      // A zero right after +41 starts no real Swiss number.
      const value = `+41 0${core.slice(0, 2)} ${core.slice(2, 5)} ${core.slice(5, 7)} ${core.slice(7, 9)} ${core.slice(9)}`;
      return Object.freeze({
        kind,
        value,
        cores: Object.freeze([core]),
        minFragment: 12,
      });
    }
  }
}

/**
 * Makes one canary of each kind.
 *
 * @returns Four new canaries.
 * @example
 * ```ts
 * const canaries = makeCanaries();
 * assertNoCanary(output, canaries.all, 'log line');
 * ```
 */
export function makeCanaries(): CanarySet {
  const token = makeCanary('token');
  const email = makeCanary('email');
  const name = makeCanary('name');
  const phone = makeCanary('phone');
  return Object.freeze({
    token,
    email,
    name,
    phone,
    all: Object.freeze([token, email, name, phone]),
  });
}

/**
 * Makes a value that passes the pattern of a tenant ID, as a positive
 * control: a test that expects it in the output proves that its output was
 * written at all.
 *
 * @returns A value such as `demo-tenant-x7k2m9q4`.
 * @example
 * ```ts
 * const control = makeControlValue();
 * expect(line).toContain(control);
 * ```
 */
export function makeControlValue(): string {
  return `demo-tenant-${randomText(lowerAlphanumeric, 8)}`;
}

// Base64 of a text depends on where it starts within groups of three bytes.
// For each of the three positions, the part of the encoding that stays the
// same whatever surrounds the text.
const base64Needles = (text: string): string[] => {
  const bytes = Buffer.from(text, 'utf8');
  const needles: string[] = [];
  for (let shift = 0; shift < 3; shift += 1) {
    const padded = Buffer.concat([Buffer.alloc(shift), bytes]);
    const encoded = padded.toString('base64');
    const start = shift === 0 ? 0 : 4;
    const end = Math.floor((shift + bytes.length) / 3) * 4;
    if (end - start >= 8) needles.push(encoded.slice(start, end));
  }
  return needles;
};

interface Needle {
  readonly text: string;
  readonly form: CanaryFinding['form'];
  readonly part: CanaryFinding['part'];
  readonly folded: boolean;
}

const needlesOf = (canary: Canary): Needle[] => {
  const needles: Needle[] = [];
  const pieces: [string, CanaryFinding['part']][] = [
    [canary.value, 'value'],
    ...canary.cores.map((core): [string, CanaryFinding['part']] => [
      core,
      'core',
    ]),
  ];
  for (const [text, part] of pieces) {
    needles.push({ text: fold(text), form: 'raw', part, folded: true });
    needles.push({
      text: fold(JSON.stringify(text).slice(1, -1)),
      form: 'json',
      part,
      folded: true,
    });
    needles.push({
      text: fold(encodeURIComponent(text)),
      form: 'url',
      part,
      folded: true,
    });
    needles.push({
      text: Buffer.from(text, 'utf8').toString('hex'),
      form: 'hex',
      part,
      folded: true,
    });
    for (const needle of base64Needles(text)) {
      needles.push({ text: needle, form: 'base64', part, folded: false });
    }
  }
  for (const core of canary.cores) {
    const folded = fold(core);
    for (
      let start = 0;
      start + canary.minFragment <= folded.length;
      start += 1
    ) {
      needles.push({
        text: folded.slice(start, start + canary.minFragment),
        form: 'raw',
        part: 'fragment',
        folded: true,
      });
    }
  }
  return needles;
};

// Removes whitespace, the literal escapes \n, \r and \t, and the joins
// "' + '" that util.inspect puts into strings it splits over several lines.
const squeeze = (text: string): string =>
  text.replaceAll(/\\[nrt]|'\s*\+\s*'|\s/g, '');

// Collects every string the haystack holds or shows. The walk calls no
// getter: own data properties, also under symbols, map and set entries, and
// typed arrays decoded as UTF-8 and Latin-1. It is iterative and keeps track
// of what it saw, so neither depth nor cycles stop it. The renderings through
// util.inspect and JSON.stringify at the end do call getters and toJSON of
// the haystack, because a leak can hide behind one.
const textsOf = (haystack: unknown): string[] => {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [haystack];
  while (queue.length > 0) {
    const item = queue.pop();
    if (typeof item === 'string') {
      texts.push(item);
      continue;
    }
    if (typeof item === 'number' || typeof item === 'bigint') {
      texts.push(String(item));
      continue;
    }
    if (typeof item !== 'object' || item === null || seen.has(item)) continue;
    seen.add(item);
    try {
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
        const bytes = ArrayBuffer.isView(item)
          ? Buffer.from(item.buffer, item.byteOffset, item.byteLength)
          : Buffer.from(item);
        texts.push(bytes.toString('utf8'), bytes.toString('latin1'));
        continue;
      }
      if (item instanceof Map) {
        for (const [key, value] of item) queue.push(key, value);
      } else if (item instanceof Set) {
        for (const value of item) queue.push(value);
      }
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key === 'string') texts.push(key);
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (property !== undefined && 'value' in property) {
          queue.push(property.value);
        }
      }
    } catch {
      // A proxy that throws hides nothing the other views below can show.
    }
  }
  if (typeof haystack !== 'string') {
    try {
      texts.push(
        inspect(haystack, {
          depth: Infinity,
          maxArrayLength: Infinity,
          maxStringLength: Infinity,
          breakLength: Infinity,
          showHidden: true,
          getters: true,
          customInspect: false,
        }),
      );
    } catch {
      // The walk above already saw the data properties.
    }
    try {
      const json = JSON.stringify(haystack);
      if (typeof json === 'string') texts.push(json);
    } catch {
      // Cycles and big integers make JSON throw; the walk covers them.
    }
  }
  return texts;
};

/**
 * Searches a haystack for canaries: the whole value, a core or a piece of a
 * core of at least `minFragment` characters, without regard to case, raw or
 * as JSON, URL, Base64 or hex encoding, also with whitespace and line joins
 * removed. Phone numbers are also found by their digits alone.
 *
 * @param haystack - A string, bytes or any value, such as an error object.
 * @param canaries - The canaries to look for.
 * @returns One finding per canary, encoding and part found.
 * @example
 * ```ts
 * expect(findCanaries(line, canaries.all)).toEqual([]);
 * ```
 */
export function findCanaries(
  haystack: unknown,
  canaries: readonly Canary[],
): readonly CanaryFinding[] {
  const views = textsOf(haystack).flatMap((text) => [
    { text, folded: fold(text), squeezed: false },
    { text: squeeze(text), folded: fold(squeeze(text)), squeezed: true },
  ]);
  const findings = new Map<string, CanaryFinding>();
  const note = (finding: CanaryFinding): void => {
    findings.set(
      `${finding.kind}|${finding.form}|${finding.part}|${String(finding.squeezed)}`,
      finding,
    );
  };
  for (const canary of canaries) {
    const needles = needlesOf(canary);
    for (const view of views) {
      for (const needle of needles) {
        const where = needle.folded ? view.folded : view.text;
        if (where.includes(needle.text)) {
          note({
            kind: canary.kind,
            form: needle.form,
            part: needle.part,
            squeezed: view.squeezed,
          });
        }
      }
      if (canary.kind === 'phone') {
        const onlyDigits = view.text.replaceAll(/\D/g, '');
        for (const core of canary.cores) {
          if (onlyDigits.includes(core)) {
            note({
              kind: canary.kind,
              form: 'digits',
              part: 'core',
              squeezed: view.squeezed,
            });
          }
        }
      }
    }
  }
  return [...findings.values()];
}

/**
 * Fails when a haystack holds a canary. The error names the label and how
 * each canary was found, never a value.
 *
 * @param haystack - The output to check.
 * @param canaries - The canaries that must not appear.
 * @param label - What the haystack is, for the error message.
 * @throws {Error} When at least one canary is found.
 * @example
 * ```ts
 * assertNoCanary(stderr, canaries.all, 'stderr of the child');
 * ```
 */
export function assertNoCanary(
  haystack: unknown,
  canaries: readonly Canary[],
  label: string,
): void {
  const findings = findCanaries(haystack, canaries);
  if (findings.length > 0) {
    throw new Error(
      `${label} holds canaries: ${findings
        .map(
          (f) =>
            `${f.kind} as ${f.part} in ${f.form}${f.squeezed ? ', squeezed' : ''}`,
        )
        .join('; ')}`,
    );
  }
}

/**
 * Fails unless every canary appears whole and unchanged in the haystack. A
 * test calls it on its input before it checks the output, so that a canary
 * that never reached the code under test cannot pass as a clean output.
 *
 * @param haystack - The input that should carry the canaries.
 * @param canaries - The canaries that must appear.
 * @param label - What the haystack is, for the error message.
 * @throws {Error} When a canary is missing or appears only in part.
 * @example
 * ```ts
 * assertPlanted(fields, [canaries.token], 'log fields');
 * ```
 */
export function assertPlanted(
  haystack: unknown,
  canaries: readonly Canary[],
  label: string,
): void {
  const texts = textsOf(haystack);
  const missing = canaries.filter(
    (canary) => !texts.some((text) => text.includes(canary.value)),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} lacks the planted canaries: ${missing.map((c) => c.kind).join(', ')}`,
    );
  }
}
