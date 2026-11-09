import { policyJsonSchema } from '@ecclium/mcp-churchtools-core';
import { describe, expect, it } from 'vitest';

import {
  checkBlockFields,
  checkRoutine,
  routineBlocks,
  routineCheckCodes,
  routineFieldOf,
} from './check.js';
import { routineJsonSchema, routineLimits } from './schema.js';

// A routine with a model, as an operator would write it, in plain values
// as the reader of YAML returns them. Each case changes a fresh copy.
const withModel = (): Record<string, unknown> => ({
  schema: 'routine.v1',
  id: 'dienstplan-report',
  schedule: '0 6 * * MON',
  inputs: [
    {
      name: 'termine',
      tool: 'ct_events_list',
      params: { from: '+0d', to: '+14d' },
      maxItems: 30,
    },
    {
      name: 'einteilungen',
      tool: 'ct_services_get_assignments',
      forEach: 'termine',
      params: { eventId: { field: 'id' } },
      maxItems: 60,
    },
  ],
  generate: {
    prompt: 'prompts/dienstplan-report.md',
    model: 'default',
    output: {
      blocks: {
        unbesetzt: {
          maxItems: 30,
          fields: {
            termin: { type: 'text', maxLength: 80 },
            datum: { type: 'date' },
          },
        },
        mehrfach: {
          maxItems: 30,
          fields: {
            person: { type: 'person' },
            anzahl: { type: 'integer', min: 2, max: 50 },
          },
        },
      },
    },
  },
  template: 'templates/dienstplan-report.md',
  output: {
    target: 'wiki',
    tool: 'ct_wiki_page_append_section',
    scope: { category: 'Berichte', page: 'Dienstplan-Auswertung' },
    idempotencyKey: 'dienstplan-report:{isoWeek}',
  },
});

// A routine without a model, with the checks of the core.
const withChecks = (): Record<string, unknown> => ({
  schema: 'routine.v1',
  id: 'wiki-hygiene',
  schedule: '0 7 1 * *',
  checks: [
    { check: 'stalePages', olderThanDays: 365, maxItems: 50 },
    { check: 'brokenLinks', maxItems: 40 },
  ],
  template: 'wiki-hygiene.md',
  output: {
    target: 'wiki',
    tool: 'ct_wiki_page_append_section',
    scope: { category: 'Berichte', page: 'Wiki-Pflege' },
    idempotencyKey: 'wiki-hygiene:{month}',
  },
  notify: [{ channel: 'stdout' }, { channel: 'file' }],
});

// A plain object at a path of the routine, to change it in place.
const at = (
  value: Record<string, unknown>,
  path: string,
): Record<string, unknown> =>
  path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      value,
    ) as Record<string, unknown>;

const changed = (
  base: () => Record<string, unknown>,
  change: (routine: Record<string, unknown>) => void,
): Record<string, unknown> => {
  const routine = base();
  change(routine);
  return routine;
};

describe('checkRoutine with a valid routine', () => {
  it('returns a routine with a model and its defaults, deeply frozen', () => {
    const result = checkRoutine(withModel());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { routine } = result;
    expect(routine.generate).toMatchObject({
      prompt: 'prompts/dienstplan-report.md',
      model: 'default',
      maxOutputTokens: routineLimits.defaultOutputTokens,
    });
    expect(routine.generate).not.toHaveProperty('redaction');
    expect(routine.inputs[1]).toEqual({
      name: 'einteilungen',
      tool: 'ct_services_get_assignments',
      forEach: 'termine',
      params: { eventId: { field: 'id' } },
      maxItems: 60,
    });
    expect(routine.inputs[0]).not.toHaveProperty('forEach');
    expect(routine.output).toMatchObject({ period: 'isoWeek' });
    expect(routine.notify).toEqual([]);
    expect(routine).not.toHaveProperty('checks');

    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(result)).toBe(true);
  });

  it('keeps a wish for redaction and a limit of tokens', () => {
    const result = checkRoutine(
      changed(withModel, (routine) => {
        Object.assign(at(routine, 'generate'), {
          redaction: 'strict',
          maxOutputTokens: routineLimits.maxOutputTokens,
        });
      }),
    );
    expect(result.ok && result.routine.generate).toMatchObject({
      redaction: 'strict',
      maxOutputTokens: routineLimits.maxOutputTokens,
    });
  });

  it('returns a routine with checks and the blocks of the checks', () => {
    const result = checkRoutine(withChecks());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routine.inputs).toEqual([]);
    expect(result.routine).not.toHaveProperty('generate');
    expect(result.routine.output).toMatchObject({ period: 'month' });
    expect(result.routine.notify).toEqual([
      { channel: 'stdout' },
      { channel: 'file' },
    ]);
    expect(routineBlocks(result.routine)).toEqual({
      stalePages: { maxItems: 50, fields: checkBlockFields.stalePages },
      brokenLinks: { maxItems: 40, fields: checkBlockFields.brokenLinks },
    });
  });

  it('gives the blocks of the model for a routine with a model', () => {
    const result = checkRoutine(withModel());
    expect(result.ok && Object.keys(routineBlocks(result.routine))).toEqual([
      'unbesetzt',
      'mehrfach',
    ]);
  });

  it('takes a draft as a file with a key per day', () => {
    const result = checkRoutine(
      changed(withModel, (routine) => {
        routine['output'] = {
          target: 'draft',
          channel: 'file',
          idempotencyKey: 'dienstplan-report:{date}',
        };
      }),
    );
    expect(result.ok && result.routine.output).toEqual({
      target: 'draft',
      channel: 'file',
      idempotencyKey: 'dienstplan-report:{date}',
      period: 'date',
    });
  });

  it('writes the names of the wiki in the normal form NFC', () => {
    const result = checkRoutine(
      changed(withModel, (routine) => {
        at(routine, 'output.scope')['page'] = 'Prüfung';
      }),
    );
    expect(result.ok && result.routine.output).toMatchObject({
      scope: { page: 'Prüfung' },
    });
  });

  it('takes a list of twelve hours, longer than a field once could be', () => {
    const result = checkRoutine(
      changed(withModel, (r) => {
        r['schedule'] = '0 0,2,4,6,8,10,12,14,16,18,20,22 * * *';
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('takes the limits of the schema at their edges', () => {
    const result = checkRoutine(
      changed(withModel, (routine) => {
        at(routine, 'generate.output.blocks.unbesetzt')['maxItems'] =
          routineLimits.blockItems;
        at(routine, 'generate.output.blocks.unbesetzt.fields.termin')[
          'maxLength'
        ] = routineLimits.textLength;
        at(routine, 'generate.output.blocks.mehrfach.fields')['anzahl'] = {
          type: 'integer',
          min: -routineLimits.integer,
          max: routineLimits.integer,
        };
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('checkRoutine with a routine it refuses', () => {
  it.each<[string, unknown, string | undefined]>([
    ['without a version', { id: 'a' }, 'schema'],
    ['with another version', { schema: 'routine.v2' }, 'schema'],
    ['with the version of the policy', { schema: 'policy.v1' }, 'schema'],
    ['that is a list', [], undefined],
    ['that is a text', 'schema: routine.v1', undefined],
    ['that is nothing', null, undefined],
  ])('refuses a value %s as of an unknown version', (_name, value, field) => {
    expect(checkRoutine(value)).toEqual(
      field === undefined
        ? { ok: false, code: 'routine_version_unknown' }
        : { ok: false, code: 'routine_version_unknown', field },
    );
  });

  it('reads the version only from an own data property', () => {
    const value = Object.create({ schema: 'routine.v1' }) as object;
    expect(checkRoutine(value)).toMatchObject({
      code: 'routine_version_unknown',
    });
    const getter = {};
    Object.defineProperty(getter, 'schema', { get: () => 'routine.v1' });
    expect(checkRoutine(getter)).toMatchObject({
      code: 'routine_version_unknown',
    });
  });

  it.each<
    [string, (routine: Record<string, unknown>) => void, string | undefined]
  >([
    ['an unknown field', (r) => (r['title'] = 'Bericht'), undefined],
    ['an ID with upper case', (r) => (r['id'] = 'Dienstplan'), 'id'],
    [
      'a text field without a length',
      (r) =>
        (at(r, 'generate.output.blocks.unbesetzt.fields')['termin'] = {
          type: 'text',
        }),
      'generate.output.blocks.unbesetzt.fields.termin.maxLength',
    ],
    [
      'a number without a range',
      (r) =>
        (at(r, 'generate.output.blocks.mehrfach.fields')['anzahl'] = {
          type: 'integer',
          min: 0,
        }),
      'generate.output.blocks.mehrfach.fields.anzahl.max',
    ],
    [
      'a kind of field the core does not know',
      (r) =>
        (at(r, 'generate.output.blocks.unbesetzt.fields')['termin'] = {
          type: 'url',
        }),
      'generate.output.blocks.unbesetzt.fields.termin.type',
    ],
    [
      'a text longer than the limit',
      (r) =>
        (at(r, 'generate.output.blocks.unbesetzt.fields.termin')['maxLength'] =
          routineLimits.textLength + 1),
      'generate.output.blocks.unbesetzt.fields.termin.maxLength',
    ],
    [
      'a block with too many entries',
      (r) =>
        (at(r, 'generate.output.blocks.unbesetzt')['maxItems'] =
          routineLimits.blockItems + 1),
      'generate.output.blocks.unbesetzt.maxItems',
    ],
    [
      'a block without fields',
      (r) => (at(r, 'generate.output.blocks.unbesetzt')['fields'] = {}),
      'generate.output.blocks.unbesetzt.fields',
    ],
    [
      'too many blocks',
      (r) =>
        (at(r, 'generate.output')['blocks'] = Object.fromEntries(
          Array.from({ length: routineLimits.blocks + 1 }, (_, index) => [
            `block_${String(index)}`,
            { maxItems: 1, fields: { text: { type: 'date' } } },
          ]),
        )),
      'generate.output.blocks',
    ],
    [
      'a block whose name does not fit its pattern',
      (r) =>
        (at(r, 'generate.output.blocks')['Unbesetzt'] = {
          maxItems: 1,
          fields: { text: { type: 'date' } },
        }),
      'generate.output.blocks',
    ],
    [
      'a prompt outside the folder',
      (r) => (at(r, 'generate')['prompt'] = '../prompts/x.md'),
      'generate.prompt',
    ],
    [
      'a prompt two folders deep',
      (r) => (at(r, 'generate')['prompt'] = 'a/b/x.md'),
      'generate.prompt',
    ],
    [
      'a template with an absolute path',
      (r) => (r['template'] = '/etc/x.md'),
      'template',
    ],
    [
      'a template that is no Markdown',
      (r) => (r['template'] = 'templates/x.txt'),
      'template',
    ],
    [
      'a hidden template',
      (r) => (r['template'] = 'templates/.x.md'),
      'template',
    ],
    [
      'a tool of another server',
      (r) => (at(r, 'inputs.0')['tool'] = 'other_events_list'),
      'inputs[0].tool',
    ],
    [
      'a parameter with a control character',
      (r) => (at(r, 'inputs.0.params')['from'] = '+0d\n'),
      'inputs[0].params.from',
    ],
    [
      'an input with too many entries',
      (r) => (at(r, 'inputs.0')['maxItems'] = routineLimits.inputItems + 1),
      'inputs[0].maxItems',
    ],
    [
      'another tool for the wiki',
      (r) => (at(r, 'output')['tool'] = 'ct_wiki_page_update'),
      'output.tool',
    ],
    [
      'a key with two periods',
      (r) =>
        (at(r, 'output')['idempotencyKey'] =
          'dienstplan-report:{isoWeek}-{date}'),
      'output.idempotencyKey',
    ],
    [
      'a key without a period',
      (r) => (at(r, 'output')['idempotencyKey'] = 'dienstplan-report'),
      'output.idempotencyKey',
    ],
    [
      'a schedule with six fields',
      (r) => (r['schedule'] = '0 0 6 * * MON'),
      'schedule',
    ],
    [
      'a model named by its vendor and version',
      (r) => (at(r, 'generate')['model'] = 'Vendor/Model 1.5'),
      'generate.model',
    ],
    [
      'a limit of tokens below the least',
      (r) =>
        (at(r, 'generate')['maxOutputTokens'] =
          routineLimits.minOutputTokens - 1),
      'generate.maxOutputTokens',
    ],
    [
      'a page of the wiki without a name',
      (r) => (at(r, 'output.scope')['page'] = ''),
      'output.scope.page',
    ],
  ])('refuses %s', (_name, change, field) => {
    expect(checkRoutine(changed(withModel, change))).toEqual(
      field === undefined
        ? { ok: false, code: 'routine_invalid' }
        : { ok: false, code: 'routine_invalid', field },
    );
  });

  it.each<[string, string, string]>([
    [
      'five fields with a form cron reads two ways',
      '0 6 * * 5L',
      'routine_schedule_invalid',
    ],
    ['a value out of range', '0 25 * * *', 'routine_schedule_invalid'],
    ['both days restricted', '0 6 1 * MON', 'routine_schedule_days'],
    [
      'more than one minute an hour',
      '0,30 6 * * MON',
      'routine_schedule_frequent',
    ],
    ['a day that does not exist', '0 6 31 2 *', 'routine_schedule_never'],
    [
      'more than one minute an hour',
      '0,30 6 * * MON',
      'routine_schedule_frequent',
    ],
    ['a day that does not exist', '0 6 31 2 *', 'routine_schedule_never'],
    [
      'a list longer than any field allows',
      `${Array.from({ length: 47 }, () => '1').join(',')} * * * *`,
      'routine_invalid',
    ],
  ])('refuses a schedule with %s', (_name, schedule, code) => {
    expect(
      checkRoutine(changed(withModel, (r) => (r['schedule'] = schedule))),
    ).toEqual({ ok: false, code, field: 'schedule' });
  });

  it('refuses a routine with a model and checks, or with neither', () => {
    const both = changed(withModel, (r) => {
      r['checks'] = [{ check: 'brokenLinks', maxItems: 5 }];
    });
    expect(checkRoutine(both)).toEqual({
      ok: false,
      code: 'routine_generate_or_checks',
      field: 'checks',
    });
    const neither = changed(withChecks, (r) => {
      delete r['checks'];
    });
    expect(checkRoutine(neither)).toEqual({
      ok: false,
      code: 'routine_generate_or_checks',
    });
  });

  it('refuses inputs without a model and a model without inputs', () => {
    const inputsWithChecks = changed(withChecks, (r) => {
      r['inputs'] = withModel()['inputs'];
    });
    expect(checkRoutine(inputsWithChecks)).toEqual({
      ok: false,
      code: 'routine_inputs',
      field: 'inputs',
    });
    const modelWithoutInputs = changed(withModel, (r) => {
      delete r['inputs'];
    });
    expect(checkRoutine(modelWithoutInputs)).toEqual({
      ok: false,
      code: 'routine_inputs',
      field: 'inputs',
    });
  });

  it.each<[string, (routine: Record<string, unknown>) => void, string, string]>(
    [
      [
        'two inputs with one name',
        (r) => (at(r, 'inputs.1')['name'] = 'termine'),
        'routine_contradiction',
        'inputs[1].name',
      ],
      [
        'a loop over an input that comes later',
        (r) => {
          const inputs = r['inputs'] as unknown[];
          inputs.reverse();
        },
        'routine_reference',
        'inputs[0].forEach',
      ],
      [
        'a loop over an input that does not exist',
        (r) => (at(r, 'inputs.1')['forEach'] = 'personen'),
        'routine_reference',
        'inputs[1].forEach',
      ],
      [
        'a loop over itself',
        (r) => (at(r, 'inputs.1')['forEach'] = 'einteilungen'),
        'routine_reference',
        'inputs[1].forEach',
      ],
      [
        'a loop over an input with a loop',
        (r) =>
          (r['inputs'] as unknown[]).push({
            name: 'mehr',
            tool: 'ct_events_get',
            forEach: 'einteilungen',
            params: { id: { field: 'eventId' } },
            maxItems: 10,
          }),
        'routine_reference',
        'inputs[2].forEach',
      ],
      [
        'a loop that uses no field of its entries',
        (r) => (at(r, 'inputs.1')['params'] = { eventId: 5 }),
        'routine_reference',
        'inputs[1].forEach',
      ],
      [
        'a field of an entry without a loop',
        (r) => (at(r, 'inputs.0.params')['to'] = { field: 'id' }),
        'routine_reference',
        'inputs[0].params.to',
      ],
      [
        'an empty range of numbers',
        (r) =>
          Object.assign(
            at(r, 'generate.output.blocks.mehrfach.fields.anzahl'),
            {
              min: 5,
              max: 4,
            },
          ),
        'routine_contradiction',
        'generate.output.blocks.mehrfach.fields.anzahl.min',
      ],
      [
        'a field with the name the template keeps for the period',
        (r) =>
          (at(r, 'generate.output.blocks.mehrfach.fields')['period'] = {
            type: 'date',
          }),
        'routine_contradiction',
        'generate.output.blocks.mehrfach.fields.period',
      ],
      [
        'a block with the name the template keeps for the period',
        (r) =>
          (at(r, 'generate.output.blocks')['period'] = {
            maxItems: 1,
            fields: { datum: { type: 'date' } },
          }),
        'routine_contradiction',
        'generate.output.blocks.period',
      ],
      [
        'the key of another routine',
        (r) => (at(r, 'output')['idempotencyKey'] = 'wiki-hygiene:{isoWeek}'),
        'routine_contradiction',
        'output.idempotencyKey',
      ],
      [
        'the key of a routine whose ID starts the same',
        (r) => (at(r, 'output')['idempotencyKey'] = 'dienstplan:{isoWeek}'),
        'routine_contradiction',
        'output.idempotencyKey',
      ],
      [
        'a draft to a channel of Pro',
        (r) =>
          (r['output'] = {
            target: 'draft',
            channel: 'mail',
            idempotencyKey: 'dienstplan-report:{date}',
          }),
        'routine_channel_unknown',
        'output.channel',
      ],
      [
        'a notice to a channel of Pro',
        (r) => (r['notify'] = [{ channel: 'webhook' }]),
        'routine_channel_unknown',
        'notify[0].channel',
      ],
      [
        'a notice to one channel twice',
        (r) => (r['notify'] = [{ channel: 'file' }, { channel: 'file' }]),
        'routine_contradiction',
        'notify[1].channel',
      ],
    ],
  )('refuses %s', (_name, change, code, field) => {
    expect(checkRoutine(changed(withModel, change))).toEqual({
      ok: false,
      code,
      field,
    });
  });

  it('refuses one check twice', () => {
    const routine = changed(withChecks, (r) => {
      r['checks'] = [
        { check: 'brokenLinks', maxItems: 5 },
        { check: 'brokenLinks', maxItems: 6 },
      ];
    });
    expect(checkRoutine(routine)).toEqual({
      ok: false,
      code: 'routine_contradiction',
      field: 'checks[1].check',
    });
  });

  it('never names a value of the file', () => {
    const secret = 'canary-value-in-the-file';
    const results = [
      checkRoutine(changed(withModel, (r) => (r[secret] = 1))),
      checkRoutine(changed(withModel, (r) => (r['id'] = secret.toUpperCase()))),
      checkRoutine(
        changed(
          withModel,
          (r) => (at(r, 'output.scope')['page'] = `${secret}\n`),
        ),
      ),
      checkRoutine(
        changed(
          withModel,
          (r) => (at(r, 'generate.output.blocks')[`${secret}!`] = {}),
        ),
      ),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result).toLowerCase()).not.toContain('canary');
    }
  });
});

describe('routineFieldOf', () => {
  it('writes names and positions and stops at anything else', () => {
    expect(routineFieldOf(['inputs', 1, 'forEach'])).toBe('inputs[1].forEach');
    expect(
      routineFieldOf(['generate', 'output', 'blocks', 'b_1', 'maxItems']),
    ).toBe('generate.output.blocks.b_1.maxItems');
    expect(routineFieldOf(['generate', 'Über', 'x'])).toBe('generate');
    expect(routineFieldOf(['generate', Symbol('x'), 'x'])).toBe('generate');
    expect(routineFieldOf([])).toBeUndefined();
  });
});

describe('the codes of the check', () => {
  it('are frozen and unique', () => {
    expect(Object.isFrozen(routineCheckCodes)).toBe(true);
    expect(new Set(routineCheckCodes).size).toBe(routineCheckCodes.length);
  });
});

describe('routineJsonSchema', () => {
  it('describes the file with its limits', () => {
    const schema = routineJsonSchema() as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(schema.required).toEqual([
      'schema',
      'id',
      'schedule',
      'template',
      'output',
    ]);
    expect(schema.properties['schema']).toMatchObject({ const: 'routine.v1' });
    const generate = schema.properties['generate'] as {
      properties: {
        output: { properties: { blocks: Record<string, unknown> } };
      };
    };
    expect(generate.properties.output.properties.blocks).toMatchObject({
      minProperties: 1,
      maxProperties: routineLimits.blocks,
    });
  });

  it('names a routine with the pattern of a routine of the policy', () => {
    const policy = policyJsonSchema() as {
      properties: {
        unattended: {
          items: { properties: { routine: { pattern: string } } };
        };
      };
    };
    const routine = routineJsonSchema() as {
      properties: { id: { pattern: string } };
    };
    expect(routine.properties.id.pattern).toBe(
      policy.properties.unattended.items.properties.routine.pattern,
    );
  });

  it('returns a new object each time', () => {
    expect(routineJsonSchema()).not.toBe(routineJsonSchema());
    expect(routineJsonSchema()).toEqual(routineJsonSchema());
  });
});
