import { createHash } from 'node:crypto';

import { loadConfig } from '@ecclium/mcp-churchtools-core';
import {
  classify,
  EccliumError,
  type Plugin,
  type PluginHost,
  type RedactionLevel,
  type TenantAssignment,
  type TenantContext,
  type ToolDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  ahvOf,
  createChurchToolsDouble,
  createMemoryQuotaStore,
  doubleOrigin,
  examplePlugin,
  groupedAhv,
  ibanOf,
  makeCanary,
  printedIban,
} from '@ecclium/mcp-churchtools-testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAuditSink } from '../audit/index.js';
import { createFileKeyProvider } from '../keys/file-provider.js';
import { KeyMaterial } from '../keys/index.js';
import { openPseudonyms } from '../redaction/pseudonym.js';
import { createToolCatalog } from '../registry/index.js';
import { createToolPipeline, type ToolRequest } from './pipeline.js';

// Golden tests of the redaction in each level (ADR 0026, ADR 0069): one
// synthetic tool gives a field of every data class, in a list, with null
// and with a missing field, and the whole result of the pipeline is
// compared with the expected one, written out here, as JSON text, so that
// the order of the fields counts too. Key, clock and the bytes of the
// boundary are fixed, so every run gives the same result. A failed call
// with contact data in its message completes the picture.
//
// Every value is synthetic: names after the placeholders, addresses at
// example.org, phone numbers of the form 000 000 12 34, and IBAN and AHV
// number made from synthetic digits with their check sum or check digit.

const loaded = loadConfig({
  environment: {
    ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
    ECCLIUM_CHURCHTOOLS_TOKEN: makeCanary('token').value,
  },
  transport: 'stdio',
});
if (!loaded.ok) throw new Error('the configuration of the test is invalid');
const token = loaded.config.churchtoolsToken;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

const noon = Date.UTC(2026, 9, 31, 12);
const zeroWidthSpace = String.fromCodePoint(0x200b);
const iban = printedIban(ibanOf('CH', '00000000000000012'));
const ahv = groupedAhv(ahvOf('000000001'), '.');

// The secret is made from a seed instead of written out, so that no secret
// scanner reads a test secret as a leaked one.
const keys = createFileKeyProvider({
  current: new KeyMaterial(
    createHash('sha256').update('golden-tests').digest('hex'),
  ),
});

const description = {
  purpose: 'Serves a test.',
  useWhen: 'A test needs it.',
  avoidWhen: 'Anything else.',
  limits: 'None.',
};

const meta = {
  capability: 'read',
  domain: 'wiki',
  requiredRights: [],
  tier: 'free',
  sensitivity: 'special',
  unattended: 'never',
  routineStable: false,
} as const;

const id = () => z.number().int().nonnegative();

// The synthetic data set: three persons and a title.
const dataset = {
  people: [
    {
      id: 12,
      firstName: 'Max',
      lastName: 'Mustermann',
      email: 'max.mustermann@example.org',
      phone: '000 000 12 34',
      birthdate: '1980-05-17',
      street: 'Musterstrasse 1',
      postcode: '8000',
      city: 'Musterstadt',
      donation: 50,
      groupId: 3,
      note: 'Kontakt: max.mustermann@example.org, 000 000 12 34',
    },
    {
      id: 13,
      firstName: 'Erika',
      lastName: 'Musterfrau',
      email: 'erika.musterfrau@example.org',
      birthdate: null,
      street: 'Musterweg 2',
      postcode: '3000',
      city: 'Musterdorf',
      donation: 120.5,
      groupId: 3,
      note: `Konto ${iban}, AHV ${ahv}${zeroWidthSpace}`,
    },
    {
      id: 14,
      firstName: 'Anna',
      lastName: 'Österfrau',
      email: null,
      phone: '0000 00 00 00',
      birthdate: '17.05.1980',
      street: 'Platz 3',
      postcode: '4000',
      city: 'Musterberg',
      donation: 0,
      groupId: 4,
      note: 'Treffen am 01.10.2026 um 19.30 in Raum 12',
    },
  ],
  title: 'Liste der Gruppe A',
  count: 3,
};

const goldenTool = {
  name: 'ct_test_golden',
  meta,
  description,
  input: z.strictObject({}),
  output: z.object({
    people: z
      .array(
        z.object({
          id: classify(id(), 'personId'),
          firstName: classify(z.string(), 'name.first'),
          lastName: classify(z.string(), 'name.last'),
          email: classify(z.string(), 'email').nullable(),
          phone: classify(z.string(), 'phone').optional(),
          birthdate: classify(z.string(), 'birthdate').nullable(),
          street: classify(z.string(), 'address'),
          postcode: classify(z.string(), 'address'),
          city: classify(z.string(), 'none'),
          donation: classify(z.number(), 'amount'),
          groupId: classify(id(), 'groupId'),
          note: classify(z.string(), 'untrusted'),
        }),
      )
      .max(5),
    title: classify(z.string(), 'untrusted'),
    count: classify(z.number().int(), 'none'),
  }),
  execute: () => Promise.resolve(dataset),
} as unknown as ToolDefinition;

// Fails with contact data in its message, as a careless tool might.
const failingTool = {
  name: 'ct_test_golden_fails',
  meta: { ...meta, sensitivity: 'none', unattended: 'policy' },
  description,
  input: z.strictObject({}),
  output: z.object({ done: classify(z.boolean(), 'none') }),
  execute: () =>
    Promise.reject(
      new EccliumError(
        'upstream',
        'No access for max.mustermann@example.org, call 000 000 12 34 or see 17.05.1980.',
      ),
    ),
} as unknown as ToolDefinition;

const testPlugin: Plugin = {
  name: 'test-plugin',
  version: '1.0.0',
  register(host: PluginHost): undefined {
    host.addTool(goldenTool);
    host.addTool(failingTool);
    return undefined;
  },
};

const request = (redaction: RedactionLevel): ToolRequest => ({
  assignment: {
    tenantId: 'default',
    actor: { kind: 'user', id: 'stdio:local-stdio' },
  } as unknown as TenantAssignment,
  mode: 'interactive',
  redaction,
  readOnly: true,
  features: [],
  signal: new AbortController().signal,
});

const call = async (name: string, level: RedactionLevel) => {
  const double = createChurchToolsDouble({ token });
  open.push(double);
  const catalog = createToolCatalog({
    core: examplePlugin,
    plugins: [testPlugin],
    readOnly: true,
    toolsets: new Set(['wiki'] as const),
  });
  const silent = Object.freeze({ write: (): boolean => true });
  const clock = Object.freeze({ now: Object.freeze(() => noon) });
  const pipeline = createToolPipeline({
    quota: createMemoryQuotaStore(),
    catalog,
    audit: createAuditSink({
      writer: silent,
      file: { write: () => true, ready: () => true },
      clock,
      isKnownTool: catalog.has,
    }),
    transport: double.transport,
    origin: doubleOrigin,
    requestsPerMinute: 300,
    clock,
    logging: { writer: silent, minLevel: 'error' },
    keys,
    // Fixed bytes for the boundary of the envelope.
    random: (size) => new Uint8Array(size).fill(0xab),
  });
  return pipeline.call(name, {}, request(level));
};

const boundary = 'abababababababab';
const envelope = (text: string): string =>
  `<<data-${boundary}>>${text}<</data-${boundary}>>`;
const removedNote = ' [ecclium: 1 hidden characters removed]';

// The pseudonyms the pipeline gives for the principal of the call, made
// with the same key for the same tenant, instance, principal and day.
const pseudonymsOf = async (
  ids: readonly number[],
): Promise<readonly string[]> => {
  const context = Object.freeze({
    tenantId: 'default',
    instance: doubleOrigin,
    actor: Object.freeze({ kind: 'user', id: 'stdio:local-stdio' }),
    clock: Object.freeze({ now: () => noon }),
  }) as unknown as TenantContext;
  const pseudonyms = await openPseudonyms(keys, context);
  try {
    return ids.map((value) => pseudonyms.hide(value));
  } finally {
    pseudonyms.erase();
  }
};

const expectedOff = {
  people: [
    {
      id: 12,
      firstName: 'Max',
      lastName: 'Mustermann',
      email: 'max.mustermann@example.org',
      phone: '000 000 12 34',
      birthdate: '1980-05-17',
      street: 'Musterstrasse 1',
      postcode: '8000',
      city: 'Musterstadt',
      donation: 50,
      groupId: 3,
      note: envelope('Kontakt: max.mustermann@example.org, 000 000 12 34'),
    },
    {
      id: 13,
      firstName: 'Erika',
      lastName: 'Musterfrau',
      email: 'erika.musterfrau@example.org',
      birthdate: null,
      street: 'Musterweg 2',
      postcode: '3000',
      city: 'Musterdorf',
      donation: 120.5,
      groupId: 3,
      note: envelope(`Konto ${iban}, AHV ${ahv}${removedNote}`),
    },
    {
      id: 14,
      firstName: 'Anna',
      lastName: 'Österfrau',
      email: null,
      phone: '0000 00 00 00',
      birthdate: '17.05.1980',
      street: 'Platz 3',
      postcode: '4000',
      city: 'Musterberg',
      donation: 0,
      groupId: 4,
      note: envelope('Treffen am 01.10.2026 um 19.30 in Raum 12'),
    },
  ],
  title: envelope('Liste der Gruppe A'),
  count: 3,
};

const expectedStandard = {
  people: [
    {
      id: 12,
      firstName: 'Max',
      lastName: 'Mustermann',
      email: 'm***@example.org',
      phone: '000 0** ** **',
      birthdate: '1980',
      street: '[masked]',
      postcode: '[masked]',
      city: 'Musterstadt',
      donation: '[masked]',
      groupId: 3,
      // standard does not check free text.
      note: envelope('Kontakt: max.mustermann@example.org, 000 000 12 34'),
    },
    {
      id: 13,
      firstName: 'Erika',
      lastName: 'Musterfrau',
      email: 'e***@example.org',
      birthdate: null,
      street: '[masked]',
      postcode: '[masked]',
      city: 'Musterdorf',
      donation: '[masked]',
      groupId: 3,
      note: envelope(`Konto ${iban}, AHV ${ahv}${removedNote}`),
    },
    {
      id: 14,
      firstName: 'Anna',
      lastName: 'Österfrau',
      email: null,
      phone: '0000 ** ** **',
      birthdate: '1980',
      street: '[masked]',
      postcode: '[masked]',
      city: 'Musterberg',
      donation: '[masked]',
      groupId: 4,
      note: envelope('Treffen am 01.10.2026 um 19.30 in Raum 12'),
    },
  ],
  title: envelope('Liste der Gruppe A'),
  count: 3,
};

const expectedStrict = (pseudonyms: readonly string[]) => ({
  people: [
    {
      id: pseudonyms[0],
      firstName: 'Max',
      lastName: 'M.',
      email: 'm***@example.org',
      phone: '000 0** ** **',
      birthdate: '1980',
      street: '[masked]',
      postcode: '[masked]',
      city: 'Musterstadt',
      donation: '[masked]',
      groupId: 3,
      note: envelope('Kontakt: [email masked], [phone masked]'),
    },
    {
      id: pseudonyms[1],
      firstName: 'Erika',
      lastName: 'M.',
      email: 'e***@example.org',
      birthdate: null,
      street: '[masked]',
      postcode: '[masked]',
      city: 'Musterdorf',
      donation: '[masked]',
      groupId: 3,
      note: envelope(
        `Konto [IBAN masked], AHV [AHV number masked]${removedNote}`,
      ),
    },
    {
      id: pseudonyms[2],
      firstName: 'Anna',
      lastName: 'Ö.',
      email: null,
      phone: '0000 ** ** **',
      birthdate: '1980',
      street: '[masked]',
      postcode: '[masked]',
      city: 'Musterberg',
      donation: '[masked]',
      groupId: 4,
      note: envelope('Treffen am 01.10.2026 um 19.30 in Raum 12'),
    },
  ],
  title: envelope('Liste der Gruppe A'),
  count: 3,
});

const dataOf = async (level: RedactionLevel): Promise<string> => {
  const outcome = await call('ct_test_golden', level);
  if (!outcome.ok) throw new Error(`the call failed: ${outcome.error.code}`);
  return JSON.stringify(outcome.data);
};

describe('the golden result of each level', () => {
  it('in off keeps every value, cleans the text and wraps free text', async () => {
    expect(await dataOf('off')).toBe(JSON.stringify(expectedOff));
  });

  it('in standard masks contact data, dates of birth, addresses and amounts', async () => {
    expect(await dataOf('standard')).toBe(JSON.stringify(expectedStandard));
  });

  it('in strict also shortens last names, gives pseudonyms and checks free text', async () => {
    // The pseudonyms come from the code under test, so their form and the
    // absence of the IDs are checked on their own.
    const pseudonyms = await pseudonymsOf([12, 13, 14]);
    expect(new Set(pseudonyms).size).toBe(3);
    for (const pseudonym of pseudonyms) {
      expect(pseudonym).toMatch(/^p1_[a-z2-7]{39}$/u);
    }
    const strict = await dataOf('strict');
    expect(strict).toBe(JSON.stringify(expectedStrict(pseudonyms)));
    for (const id of ['12', '13', '14']) {
      expect(strict).not.toContain(`"id":${id}`);
    }
  });
});

describe('the golden message of a failed call', () => {
  it.each([
    [
      'off',
      'No access for max.mustermann@example.org, call 000 000 12 34 or see 17.05.1980.',
    ],
    [
      'standard',
      'No access for m***@example.org, call 000 0** ** ** or see 1980.',
    ],
    [
      'strict',
      'No access for m***@example.org, call 000 0** ** ** or see 1980.',
    ],
  ] as const)('in %s', async (level, message) => {
    const outcome = await call('ct_test_golden_fails', level);
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'upstream', message },
    });
  });
});
