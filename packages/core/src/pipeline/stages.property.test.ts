import { createHash } from 'node:crypto';

import type {
  DataClass,
  RedactionLevel,
  TenantContext,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  ahvOf,
  canaryFrom,
  coreToolCatalog,
  groupedAhv,
  ibanOf,
  printedIban,
  searchable,
  variantOf,
} from '@ecclium/mcp-churchtools-testkit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import { freeTextMarkers } from '../redaction/free-text.js';
import { maskedValue } from '../redaction/mask.js';
import { openPseudonyms, type Pseudonyms } from '../redaction/pseudonym.js';
import { pseudonymPattern } from '../redaction/pseudonym-form.js';
import type { ShapeNode } from '../registry/index.js';
import { markUntrusted, redact } from './stages.js';

// The redaction over the shape of every tool of the core, in every level
// (ADR 0026, ADR 0069, ADR 0070). For each tool, values come from the
// shape the registry kept of its output, with a canary in every leaf whose
// class is personal, in variants that NFKC folds back and with hidden
// characters. The stages redact and markUntrusted then run as the pipeline
// runs them, and every leaf is checked against the table of ADR 0026:
//
// - off keeps every value, which shows that the test sees it,
// - standard and strict mask e-mail addresses, phone numbers and dates of
//   birth and replace addresses and amounts with the marker,
// - strict also shortens last names, turns IDs of persons into pseudonyms
//   that give the ID back, and puts a marker in place of an address, a
//   number, an IBAN or an AHV number in free text,
// - every free text stands in the envelope, in every level.
//
// The values come from the shape, not from the schema of the tool, so a
// value the schema would refuse still runs through the stages; that is
// stricter than operation. A fixed seed keeps the runs the same in CI.

const seed = 70_007;
const levels: readonly RedactionLevel[] = ['off', 'standard', 'strict'];
const boundary = 'a1b2c3d4e5f6a7b8';
const pattern = new RegExp(pseudonymPattern, 'u');

/** What a leaf was given, to check what came out of it. */
interface LeafInfo {
  readonly dataClass: DataClass | undefined;
  readonly cores: readonly string[];
  readonly marker?: keyof typeof freeTextMarkers;
}

/** A value and, in the same shape, what each of its leaves was given. */
interface Gen {
  readonly value: unknown;
  readonly info: unknown;
}

const choices = fc.array(fc.record({ form: fc.nat(8), hidden: fc.nat(20) }), {
  maxLength: 40,
});

// A text in a variant and the parts of it that a mask must hide.
const varied = (
  dataClass: DataClass,
  value: string,
  cores: readonly string[],
): fc.Arbitrary<Gen> =>
  choices.map((chosen) => ({
    value: variantOf(value, chosen),
    info: { dataClass, cores } satisfies LeafInfo,
  }));

const lowerCore = /^[a-z0-9]{10}$/;

const emails = fc
  .tuple(fc.stringMatching(lowerCore), fc.stringMatching(lowerCore))
  .map((cores) => canaryFrom('email', cores));
const phones = fc
  .stringMatching(/^[0-9]{12}$/)
  .map((core) => canaryFrom('phone', [core]));
const firstNames = fc.stringMatching(/^[A-Z][a-z]{11}$/);
const lastNames = fc.stringMatching(/^[A-Z][a-z]{10}[äöüé]$/);
const words = fc.stringMatching(/^[a-z]{0,8}$/);

const dates = fc
  .record({
    year: fc.integer({ min: 1900, max: 2025 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ year, month, day }) =>
      `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );

// A free text with one value the check of strict must find.
const freeTexts: fc.Arbitrary<Gen> = fc
  .record({
    planted: fc.oneof(
      emails.map((canary) => ({
        marker: 'email' as const,
        text: canary.value,
        cores: canary.cores,
      })),
      phones.map((canary) => ({
        marker: 'phone' as const,
        text: canary.value,
        cores: canary.cores,
      })),
      fc
        .tuple(
          fc.constantFrom('CH', 'DE', 'AT'),
          fc.stringMatching(/^[0-9]{17}$/),
        )
        .map(([country, rest]) => ({
          marker: 'iban' as const,
          text: printedIban(ibanOf(country, rest)),
          cores: [rest],
        })),
      fc.stringMatching(/^[0-9]{9}$/).map((nine) => {
        const ahv = ahvOf(nine);
        return {
          marker: 'ahv' as const,
          text: groupedAhv(ahv, '.'),
          cores: [ahv.slice(3)],
        };
      }),
    ),
    chosen: choices,
    before: words,
    after: words,
  })
  .map(({ planted, chosen, before, after }) => ({
    value: `${before} ${variantOf(planted.text, chosen)} ${after}`,
    info: {
      dataClass: 'untrusted',
      cores: planted.cores,
      marker: planted.marker,
    } satisfies LeafInfo,
  }));

type Leaf = Extract<ShapeNode, { readonly kind: 'leaf' }>;

// A value without a canary, of one of the types of the leaf.
const plainOf = (node: Leaf): fc.Arbitrary<Gen> => {
  const options: fc.Arbitrary<unknown>[] = [];
  if (node.types.includes('string')) options.push(words);
  if (node.types.includes('number')) {
    options.push(fc.integer({ min: 0, max: 1_000_000 }));
  }
  if (node.types.includes('boolean')) options.push(fc.boolean());
  if (node.types.includes('null')) options.push(fc.constant(null));
  return fc.oneof(...options).map((value) => ({
    value,
    info: { dataClass: node.dataClass, cores: [] } satisfies LeafInfo,
  }));
};

const leafOf = (node: Leaf): fc.Arbitrary<Gen> => {
  const text = node.types.includes('string');
  const number = node.types.includes('number');
  const { dataClass } = node;
  switch (dataClass) {
    case 'personId':
      if (!number) break;
      // Ten digits, so that no other value of the result is one.
      return fc
        .integer({ min: 1_000_000_000, max: 1_999_999_999 })
        .map((id) => ({
          value: id,
          info: { dataClass, cores: [String(id)] } satisfies LeafInfo,
        }));
    case 'name.first':
      if (!text) break;
      return firstNames.chain((name) => varied(dataClass, name, [name]));
    case 'name.last':
      if (!text) break;
      return lastNames.chain((name) => varied(dataClass, name, [name]));
    case 'email':
      if (!text) break;
      return emails.chain((canary) =>
        varied(dataClass, canary.value, canary.cores),
      );
    case 'phone':
      if (!text) break;
      return phones.chain((canary) =>
        varied(dataClass, canary.value, canary.cores),
      );
    case 'birthdate':
      if (!text) break;
      return dates.chain((date) =>
        varied(dataClass, date, [date.replaceAll('-', '')]),
      );
    case 'address':
    case 'amount':
      return fc
        .integer({ min: 2_000_000_000, max: 2_999_999_999 })
        .map((value) => ({
          value: text ? `Teil ${String(value)}` : value,
          info: { dataClass, cores: [String(value)] } satisfies LeafInfo,
        }));
    case 'untrusted':
      if (!text) break;
      return freeTexts;
    default:
      break;
  }
  return plainOf(node);
};

// A value of a node that may be missing or null, as its shape says.
const presentOf = (
  node: ShapeNode,
  inner: fc.Arbitrary<Gen>,
): fc.Arbitrary<Gen | undefined> => {
  const options: fc.Arbitrary<Gen | undefined>[] = [inner];
  if (node.nullable) {
    options.push(fc.constant({ value: null, info: null }));
  }
  if (node.optional) options.push(fc.constant(undefined));
  return options.length === 1 ? inner : fc.oneof(...options);
};

const genOf = (node: ShapeNode): fc.Arbitrary<Gen> => {
  switch (node.kind) {
    case 'leaf':
      return leafOf(node);
    case 'array':
      return fc.array(present(node.element), { maxLength: 3 }).map((items) => ({
        value: items.map((item) => item?.value),
        info: items.map((item) => item?.info),
      }));
    case 'tuple':
      return fc.tuple(...node.items.map(present)).map((items) => ({
        value: items.map((item) => item?.value),
        info: items.map((item) => item?.info),
      }));
    case 'object': {
      const keys = Object.keys(node.fields);
      return fc
        .tuple(...keys.map((key) => present(node.fields[key] as ShapeNode)))
        .map((items) => {
          const value: Record<string, unknown> = {};
          const info: Record<string, unknown> = {};
          items.forEach((item, index) => {
            const key = keys[index] as string;
            if (item === undefined) return;
            value[key] = item.value;
            info[key] = item.info;
          });
          return { value, info };
        });
    }
  }
};

const present = (node: ShapeNode): fc.Arbitrary<Gen | undefined> =>
  presentOf(node, genOf(node));

// The text as the search reads it, without spaces and the signs that
// separate the parts of a number or a date.
const compact = (text: string): string =>
  searchable(text).replaceAll(/[\s.\-/()+,]/gu, '');

const holds = (output: unknown, cores: readonly string[]): void => {
  expect(typeof output).toBe('string');
  for (const core of cores) {
    expect(compact(output as string)).toContain(compact(core));
  }
};

const hides = (output: unknown, cores: readonly string[]): void => {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  for (const core of cores) {
    expect(compact(text)).not.toContain(compact(core));
  }
};

const checkLeaf = (
  info: LeafInfo,
  input: unknown,
  output: unknown,
  level: RedactionLevel,
  pseudonyms: Pseudonyms,
): void => {
  const masking = level !== 'off';
  const strict = level === 'strict';
  switch (info.dataClass) {
    case 'personId':
      if (!strict) {
        expect(output).toBe(input);
        return;
      }
      expect(output).toMatch(pattern);
      expect(pseudonyms.reveal(output)).toBe(input);
      return;
    case 'name.last':
      if (!strict) {
        holds(output, info.cores);
        return;
      }
      hides(output, info.cores);
      expect(
        output === maskedValue || /^.{1,2}\.$/u.test(output as string),
        String(output),
      ).toBe(true);
      return;
    case 'email':
    case 'phone':
    case 'birthdate':
      if (masking) hides(output, info.cores);
      else holds(output, info.cores);
      return;
    case 'address':
    case 'amount':
      if (masking) expect(output).toBe(maskedValue);
      else expect(output).toBe(input);
      return;
    case 'untrusted': {
      const text = output as string;
      expect(text.startsWith(`<<data-${boundary}>>`)).toBe(true);
      expect(text.endsWith(`<</data-${boundary}>>`)).toBe(true);
      if (info.marker === undefined) return;
      if (strict) {
        hides(output, info.cores);
        expect(text).toContain(freeTextMarkers[info.marker]);
      } else {
        holds(output, info.cores);
      }
      return;
    }
    default:
      if (info.cores.length > 0) holds(output, info.cores);
      else expect(output).toBe(input);
  }
};

// Walks the shape, the input, what each leaf was given and the output
// together. A missing value stays missing and null stays null.
const check = (
  node: ShapeNode,
  input: unknown,
  info: unknown,
  output: unknown,
  level: RedactionLevel,
  pseudonyms: Pseudonyms,
): void => {
  if (input === undefined || input === null) {
    expect(output).toBe(input);
    return;
  }
  switch (node.kind) {
    case 'leaf':
      checkLeaf(info as LeafInfo, input, output, level, pseudonyms);
      return;
    case 'array':
    case 'tuple': {
      const items = input as readonly unknown[];
      const infos = info as readonly unknown[];
      const outputs = output as readonly unknown[];
      expect(outputs).toHaveLength(items.length);
      items.forEach((item, index) => {
        const child = node.kind === 'array' ? node.element : node.items[index];
        check(
          child as ShapeNode,
          item,
          infos[index],
          outputs[index],
          level,
          pseudonyms,
        );
      });
      return;
    }
    case 'object': {
      const fields = input as Readonly<Record<string, unknown>>;
      const infos = info as Readonly<Record<string, unknown>>;
      const outputs = output as Readonly<Record<string, unknown>>;
      expect(new Set(Object.keys(outputs))).toEqual(
        new Set(Object.keys(fields)),
      );
      for (const [key, field] of Object.entries(node.fields)) {
        check(field, fields[key], infos[key], outputs[key], level, pseudonyms);
      }
    }
  }
};

const entries = coreToolCatalog().list();

const context = Object.freeze({
  tenantId: 'default',
  instance: 'https://example.church.tools',
  actor: Object.freeze({ kind: 'user', id: 'stdio:local-stdio' }),
  clock: Object.freeze({ now: () => Date.UTC(2026, 9, 31, 12) }),
}) as unknown as TenantContext;

// The secret is made from a seed instead of written out, so that no secret
// scanner reads a test secret as a leaked one.
const keys = createFileKeyProvider({
  current: new KeyMaterial(
    createHash('sha256').update('shape-properties').digest('hex'),
  ),
});

describe('the redaction over the shape of every tool', () => {
  it('covers the 32 tools of the core and their personal classes', () => {
    expect(entries.map((entry) => entry.name)).toHaveLength(32);
    const classes = new Set<DataClass | undefined>();
    const visit = (node: ShapeNode): void => {
      if (node.kind === 'leaf') classes.add(node.dataClass);
      else if (node.kind === 'object')
        Object.values(node.fields).forEach(visit);
      else if (node.kind === 'array') visit(node.element);
      else node.items.forEach(visit);
    };
    for (const entry of entries) visit(entry.shape.root);
    for (const dataClass of [
      'personId',
      'groupId',
      'name.first',
      'name.last',
      'email',
      'untrusted',
    ] as const) {
      expect(classes.has(dataClass), dataClass).toBe(true);
    }
  });

  describe.each(levels)('in %s', (level) => {
    it.each(entries.map((entry) => [entry.name, entry] as const))(
      'keeps to the table of the classes for %s',
      async (_name, entry) => {
        const { root } = entry.shape;
        const pseudonyms = await openPseudonyms(keys, context);
        try {
          fc.assert(
            fc.property(genOf(root), (generated) => {
              const redacted = redact(
                generated.value,
                root,
                level,
                pseudonyms.hide,
              );
              const output = markUntrusted(redacted, root, boundary);
              check(
                root,
                generated.value,
                generated.info,
                output,
                level,
                pseudonyms,
              );
            }),
            { seed, numRuns: 20 },
          );
        } finally {
          pseudonyms.erase();
        }
      },
      20_000,
    );
  });
});
