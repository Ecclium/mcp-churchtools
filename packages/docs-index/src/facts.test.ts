import { readFileSync } from 'node:fs';

import {
  syntheticFactFiles,
  syntheticFacts,
  syntheticRightsPage,
  syntheticThingsPage,
} from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  DocsFactsError,
  jsonDepth,
  maxJsonDepth,
  factFileLimits,
  factFiles,
  type FactFileTexts,
  type Facts,
  type FactViolation,
  maxShapeDepth,
  parseFactFiles,
  type Shape,
  shapeDepth,
} from './facts.js';

// The checks of the facts (ADR 0066). Each rule has a case that breaks it
// in otherwise valid synthetic facts, the counter-check to the synthetic
// facts and the files under data/ passing.

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

const dataDir = new URL('../data/', import.meta.url);

function readData(): FactFileTexts {
  const read = (name: string) => readFileSync(new URL(name, dataDir), 'utf8');
  return {
    'SOURCES.json': read(factFiles.sources),
    'operations.json': read(factFiles.operations),
    'rights.json': read(factFiles.rights),
    'academy.json': read(factFiles.academy),
    'operation-rights.json': read(factFiles.operationRights),
  };
}

function violationsOf(texts: FactFileTexts): readonly FactViolation[] {
  try {
    parseFactFiles(texts);
  } catch (error) {
    if (error instanceof DocsFactsError) {
      return error.violations;
    }
    throw error;
  }
  return [];
}

function changed(change: (facts: Mutable<Facts>) => void): FactFileTexts {
  const facts = syntheticFacts() as Mutable<Facts>;
  change(facts);
  return syntheticFactFiles(facts);
}

function firstOperation(facts: Mutable<Facts>) {
  const operation = facts.operations.entries[1];
  if (operation === undefined) {
    throw new Error('the synthetic facts lost an operation');
  }
  return operation;
}

function nest(depth: number): Shape {
  let shape: Shape = { type: ['string'] };
  for (let step = 0; step < depth; step += 1) {
    shape = { type: ['array'], items: shape };
  }
  return shape;
}

describe('the files under data/', () => {
  it('pass every check', () => {
    const facts = parseFactFiles(readData());
    expect(facts.sources.format).toBe('ecclium.docs.sources.v1');
  });
});

describe('parseFactFiles', () => {
  it('accepts the synthetic facts', () => {
    const facts = parseFactFiles(syntheticFactFiles());
    expect(facts.operations.entries).toHaveLength(5);
    expect(facts.rights.entries).toHaveLength(4);
    expect(facts.academy.entries).toHaveLength(2);
  });

  it('rejects a file over its limit before it parses it', () => {
    const texts = {
      ...syntheticFactFiles(),
      'rights.json': ' '.repeat(factFileLimits['rights.json'] + 1),
    };
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: '', rule: 'size' },
    ]);
  });

  it('rejects a file that is not JSON', () => {
    const texts = { ...syntheticFactFiles(), 'SOURCES.json': '{' };
    expect(violationsOf(texts)).toEqual([
      { file: 'SOURCES.json', path: '', rule: 'json' },
    ]);
  });

  it('rejects a file that is not in canonical form', () => {
    const texts = syntheticFactFiles();
    const compact = JSON.stringify(JSON.parse(texts['academy.json']));
    expect(violationsOf({ ...texts, 'academy.json': compact })).toEqual([
      { file: 'academy.json', path: '', rule: 'canonical' },
    ]);
  });

  it('rejects fields in another order', () => {
    const texts = syntheticFactFiles();
    const sources = JSON.parse(texts['SOURCES.json']) as Record<
      string,
      unknown
    >;
    const reordered = { openapi: sources['openapi'], ...sources };
    expect(
      violationsOf({ ...texts, 'SOURCES.json': canonicalJson(reordered) }),
    ).toEqual([{ file: 'SOURCES.json', path: '', rule: 'canonical' }]);
  });

  it('rejects an unknown field without naming it or its value', () => {
    const sentinel = 'sentinel-value-7f3a';
    const texts = changed((facts) => {
      Object.assign(firstOperation(facts), { [sentinel]: sentinel });
    });
    const violations = violationsOf(texts);
    expect(violations).toEqual([
      { file: 'operations.json', path: 'entries[1]', rule: 'format' },
    ]);
    expect(() => parseFactFiles(texts)).toThrow(DocsFactsError);
    expect(() => parseFactFiles(texts)).not.toThrow(sentinel);
  });

  it('rejects a wrong value without naming it', () => {
    const sentinel = 'Sentinel-Method';
    const texts = changed((facts) => {
      Object.assign(firstOperation(facts), { method: sentinel });
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'operations.json', path: 'entries[1].method', rule: 'format' },
    ]);
    expect(() => parseFactFiles(texts)).not.toThrow(sentinel);
  });

  it.each([
    ['a line break in a summary', 'summary', 'Get\nit'],
    ['a control character in a description', 'description', 'Get\u0007it'],
    ['an empty summary', 'summary', ''],
  ])('rejects %s', (_name, field, value) => {
    const texts = changed((facts) => {
      Object.assign(firstOperation(facts), { [field]: value });
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'operations.json', path: `entries[1].${field}`, rule: 'format' },
    ]);
  });

  it.each([
    ['a soft hyphen', 'Grup\u00ADpen'],
    ['a zero-width space', 'Grup\u200Bpen'],
    ['a change of direction', 'Grup\u202Epen'],
    ['a TAG character', 'Grup\u{E0041}pen'],
    ['a character for private use', 'Grup\uE000pen'],
    ['a lone surrogate', 'Grup\uD800pen'],
    ['a variation selector', `Grup${String.fromCodePoint(0xe0100)}pen`],
    ['a grapheme joiner', `Grup${String.fromCodePoint(0x34f)}pen`],
    ['a filler of Hangul', `Grup${String.fromCodePoint(0x3164)}pen`],
  ])('rejects %s in a text', (_name, description) => {
    const texts = changed((facts) => {
      firstOperation(facts).description = description;
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operations.json',
        path: 'entries[1].description',
        rule: 'format',
      },
    ]);
  });

  it.each<[string, (facts: Mutable<Facts>) => void, string, string]>([
    [
      'a right name over 64 characters',
      (facts) => {
        const right = facts.rights.entries[3];
        if (right !== undefined) {
          right.name = `view ${'x'.repeat(60)}`;
        }
      },
      'rights.json',
      'entries[3].name',
    ],
    [
      'a module over 32 characters',
      (facts) => {
        const right = facts.rights.entries[3];
        if (right !== undefined) {
          right.module = 'z'.repeat(33);
        }
      },
      'rights.json',
      'entries[3].module',
    ],
    [
      'an operationId over 128 characters',
      (facts) => {
        const last = facts.operations.entries[4];
        if (last !== undefined) {
          last.operationId = `z${'x'.repeat(128)}`;
        }
      },
      'operations.json',
      'entries[4].operationId',
    ],
  ])('rejects %s', (_name, change, file, path) => {
    expect(violationsOf(changed(change))).toEqual([
      { file, path, rule: 'format' },
    ]);
  });

  it('keeps line breaks and tabs in a text', () => {
    const texts = changed((facts) => {
      firstOperation(facts).description = 'One\n\ttwo';
    });
    expect(violationsOf(texts)).toEqual([]);
  });

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['a day in another form', '30.06.2025'],
  ])('rejects %s as the last change of a page', (_name, modified) => {
    const texts = changed((facts) => {
      const page = facts.academy.entries[0];
      if (page !== undefined) {
        page.modified = modified;
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'academy.json', path: 'entries[0].modified', rule: 'format' },
    ]);
  });

  it.each([
    ['an hour after 23', '2026-10-29T24:00:00Z'],
    ['a time without Z', '2026-10-29T08:00:00'],
  ])('rejects %s as the time of a source', (_name, retrievedAt) => {
    const texts = changed((facts) => {
      if (facts.sources.openapi !== undefined) {
        facts.sources.openapi.retrievedAt = retrievedAt;
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'SOURCES.json', path: 'openapi.retrievedAt', rule: 'format' },
    ]);
  });

  it.each([
    ['a host', 'https://example.church.tools/de/help/'],
    ['no language', '/help/synthetisch/'],
    ['another language', '/en/help/synthetisch/'],
    ['a query', '/de/help/?p=1'],
  ])('rejects a path of a page with %s', (_name, path) => {
    const texts = changed((facts) => {
      const page = facts.academy.entries[1];
      if (page !== undefined) {
        page.path = path;
      }
    });
    expect(violationsOf(texts)).toContainEqual({
      file: 'academy.json',
      path: 'entries[1].path',
      rule: 'format',
    });
  });

  it.each<[string, (facts: Mutable<Facts>) => void, FactViolation]>([
    [
      'operations',
      (facts) => {
        facts.operations.entries.reverse();
      },
      { file: 'operations.json', path: 'entries[1]', rule: 'order' },
    ],
    [
      'two operations with one ID',
      (facts) => {
        const second = facts.operations.entries[2];
        if (second !== undefined) {
          second.operationId = firstOperation(facts).operationId;
        }
      },
      { file: 'operations.json', path: 'entries[2]', rule: 'order' },
    ],
    [
      'tags',
      (facts) => {
        firstOperation(facts).tags = ['b', 'a'];
      },
      { file: 'operations.json', path: 'entries[1].tags[1]', rule: 'order' },
    ],
    [
      'parameters',
      (facts) => {
        const members = facts.operations.entries[2];
        members?.parameters.reverse();
      },
      {
        file: 'operations.json',
        path: 'entries[2].parameters[1]',
        rule: 'order',
      },
    ],
    [
      'answers',
      (facts) => {
        firstOperation(facts).responses.reverse();
      },
      {
        file: 'operations.json',
        path: 'entries[1].responses[1]',
        rule: 'order',
      },
    ],
    [
      'properties',
      (facts) => {
        const body = firstOperation(facts).responses[0]?.content[0]?.schema;
        body?.properties?.[0]?.schema.properties?.reverse();
      },
      {
        file: 'operations.json',
        path: 'entries[1].responses[0].content[0].schema.properties[0].schema.properties[1]',
        rule: 'order',
      },
    ],
    [
      'kinds of value',
      (facts) => {
        const parameter = firstOperation(facts).parameters[0];
        if (parameter !== undefined) {
          parameter.schema = { type: ['string', 'null'] };
        }
      },
      {
        file: 'operations.json',
        path: 'entries[1].parameters[0].schema.type[1]',
        rule: 'order',
      },
    ],
    [
      'rights',
      (facts) => {
        facts.rights.entries.reverse();
      },
      { file: 'rights.json', path: 'entries[1]', rule: 'order' },
    ],
    [
      'pages of a right',
      (facts) => {
        facts.rights.entries[2]?.pages.reverse();
      },
      { file: 'rights.json', path: 'entries[2].pages[1]', rule: 'order' },
    ],
    [
      'help pages',
      (facts) => {
        facts.academy.entries.reverse();
      },
      { file: 'academy.json', path: 'entries[1]', rule: 'order' },
    ],
    [
      'fetched pages',
      (facts) => {
        facts.sources.academy?.pages.reverse();
      },
      { file: 'SOURCES.json', path: 'academy.pages[1]', rule: 'order' },
    ],
  ])('rejects unsorted %s', (_name, change, violation) => {
    expect(violationsOf(changed(change))).toContainEqual(violation);
  });

  it(`accepts a schema ${String(maxShapeDepth)} steps deep and rejects one deeper`, () => {
    const at = (depth: number) =>
      changed((facts) => {
        const parameter = firstOperation(facts).parameters[0];
        if (parameter !== undefined) {
          parameter.schema = nest(depth) as Mutable<Shape>;
        }
      });
    expect(violationsOf(at(maxShapeDepth))).toEqual([]);
    expect(violationsOf(at(maxShapeDepth + 1))).toEqual([
      {
        file: 'operations.json',
        path: 'entries[1].parameters[0].schema',
        rule: 'depth',
      },
    ]);
  });

  it('accepts a schema as large as the bounds and rejects one larger', () => {
    // The real document holds 319 properties, 38 members of an anyOf and
    // a description of 4'349 characters; the bounds leave room above.
    const withSchema = (schema: Shape) =>
      changed((facts) => {
        const parameter = firstOperation(facts).parameters[0];
        if (parameter !== undefined) {
          parameter.schema = schema as Mutable<Shape>;
        }
      });
    const properties = (count: number): Shape => ({
      type: ['object'],
      properties: Array.from({ length: count }, (_, index) => ({
        name: `p${String(index).padStart(3, '0')}`,
        required: false,
        schema: { type: ['string'] },
      })),
    });
    const members = (count: number): Shape => ({
      anyOf: Array.from({ length: count }, () => ({ type: ['string'] })),
    });
    const described = (length: number): Shape => ({
      type: ['string'],
      description: 'd'.repeat(length),
    });
    const at = 'entries[1].parameters[0].schema';
    expect(violationsOf(withSchema(properties(500)))).toEqual([]);
    expect(violationsOf(withSchema(properties(501)))).toEqual([
      { file: 'operations.json', path: `${at}.properties`, rule: 'format' },
    ]);
    expect(violationsOf(withSchema(members(50)))).toEqual([]);
    expect(violationsOf(withSchema(members(51)))).toEqual([
      { file: 'operations.json', path: `${at}.anyOf`, rule: 'format' },
    ]);
    expect(violationsOf(withSchema(described(10_000)))).toEqual([]);
    expect(violationsOf(withSchema(described(10_001)))).toEqual([
      { file: 'operations.json', path: `${at}.description`, rule: 'format' },
    ]);
  });

  it.each([
    ['*/*', true],
    ['text/*', true],
    ['*/json', false],
    ['*', false],
  ])('takes the media type %s: %s', (mediaType, accepted) => {
    const texts = changed((facts) => {
      const response = facts.operations.entries[0]?.responses[0];
      if (response !== undefined) {
        response.content = [{ mediaType }];
      }
    });
    expect(violationsOf(texts)).toEqual(
      accepted
        ? []
        : [
            {
              file: 'operations.json',
              path: 'entries[0].responses[0].content[0].mediaType',
              rule: 'format',
            },
          ],
    );
  });

  it('rejects unsorted media types and a deep schema in a request', () => {
    const unsorted = changed((facts) => {
      facts.operations.entries[4]?.requestBody?.content.push({
        mediaType: 'application/a',
      });
    });
    expect(violationsOf(unsorted)).toEqual([
      {
        file: 'operations.json',
        path: 'entries[4].requestBody.content[1]',
        rule: 'order',
      },
    ]);
    const deep = changed((facts) => {
      const body = facts.operations.entries[4]?.requestBody?.content[0];
      if (body !== undefined) {
        body.schema = nest(maxShapeDepth + 1) as Mutable<Shape>;
      }
    });
    expect(violationsOf(deep)).toEqual([
      {
        file: 'operations.json',
        path: 'entries[4].requestBody.content[0].schema',
        rule: 'depth',
      },
    ]);
  });

  it('rejects a value nested too deep before it walks it', () => {
    const levels = 60_000;
    const texts = {
      ...syntheticFactFiles(),
      'operations.json': `{"format":"ecclium.docs.operations.v1","notice":"x","entries":[${'['.repeat(levels)}${']'.repeat(levels)}]}`,
    };
    expect(violationsOf(texts)).toEqual([
      { file: 'operations.json', path: '', rule: 'depth' },
    ]);
  });

  it('rejects facts without their source and a source without facts', () => {
    const withoutSource = changed((facts) => {
      delete facts.sources.permissions;
    });
    expect(violationsOf(withoutSource)).toEqual([
      { file: 'SOURCES.json', path: 'permissions', rule: 'source' },
      { file: 'rights.json', path: 'entries', rule: 'source' },
    ]);
    const withoutFacts = changed((facts) => {
      facts.operations.entries = [];
      facts.operationRights.entries = [];
    });
    expect(violationsOf(withoutFacts)).toEqual([
      { file: 'SOURCES.json', path: 'openapi', rule: 'source' },
      { file: 'operations.json', path: 'entries', rule: 'source' },
    ]);
  });

  it('rejects a right that names a page outside academy.json', () => {
    const texts = changed((facts) => {
      facts.academy.entries = facts.academy.entries.filter(
        (page) => page.path === syntheticRightsPage,
      );
      if (facts.sources.academy !== undefined) {
        facts.sources.academy.pages = facts.sources.academy.pages.filter(
          (page) => page.path === syntheticRightsPage,
        );
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'entries[2].pages[1]', rule: 'reference' },
    ]);
  });

  it('rejects a label from a page outside academy.json', () => {
    const texts = changed((facts) => {
      const label = facts.rights.entries[1]?.label;
      if (label !== undefined && 'page' in label) {
        label.page = '/de/help/synthetisch/fehlt/';
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'entries[1].label.page', rule: 'reference' },
    ]);
  });

  it('rejects a label its page does not write before the name', () => {
    const texts = changed((facts) => {
      const label = facts.rights.entries[3]?.label;
      if (label !== undefined) {
        // The page names this label, but for another right.
        label.text = 'Dinge bearbeiten';
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'entries[3].label', rule: 'evidence' },
    ]);
  });

  it('accepts a label from a finding without a page', () => {
    const facts = parseFactFiles(syntheticFactFiles());
    expect(facts.rights.entries[0]?.label).toEqual({
      text: 'Dinge bearbeiten',
      finding: 'F2',
      version: '3.137',
    });
  });

  it('rejects a label from a finding without a version', () => {
    const texts = changed((facts) => {
      const label = facts.rights.entries[0]?.label;
      if (label !== undefined && 'finding' in label) {
        label.version = 'neu';
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'entries[0].label.version', rule: 'format' },
    ]);
  });

  it('rejects an explaining page that names neither the right nor its label', () => {
    const texts = changed((facts) => {
      facts.rights.entries[3]?.pages.push(syntheticThingsPage);
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'entries[3].pages[1]', rule: 'evidence' },
    ]);
  });

  it('rejects fetched pages that differ from the help pages', () => {
    const texts = changed((facts) => {
      facts.sources.academy?.pages.pop();
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'SOURCES.json', path: 'academy.pages', rule: 'reference' },
    ]);
  });

  it('rejects a pairing with an operation, a right or a page that does not exist', () => {
    const texts = changed((facts) => {
      const [unmapped, read, members] = facts.operationRights.entries;
      if (unmapped !== undefined) {
        unmapped.operationId = 'deleteSyntheticThingz';
      }
      if (read !== undefined && 'needs' in read) {
        const right = read.needs[0]?.rights[0];
        if (right !== undefined) {
          right.name = 'view thingz';
        }
      }
      if (members !== undefined && 'needs' in members) {
        const evidence = members.needs[0]?.evidence[0];
        if (evidence?.kind === 'academy') {
          evidence.page = '/de/help/synthetisch/fehlt/';
        }
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[0].operationId',
        rule: 'reference',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[1].needs[0].rights[0]',
        rule: 'reference',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[0].evidence[0].page',
        rule: 'reference',
      },
    ]);
  });

  it('rejects evidence from the document that names none of the rights', () => {
    const texts = changed((facts) => {
      const operation = facts.operations.entries[2];
      if (operation !== undefined) {
        operation.description = 'Requires the right view things.';
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[0].evidence[2]',
        rule: 'evidence',
      },
    ]);
  });

  it('rejects a help page as the only evidence and one that names no right', () => {
    const texts = changed((facts) => {
      const members = facts.operationRights.entries[2];
      if (members !== undefined && 'needs' in members) {
        const [need, other] = members.needs;
        if (need !== undefined) {
          need.evidence = need.evidence.slice(0, 1);
          delete need.without;
        }
        if (other !== undefined) {
          other.evidence = [{ kind: 'academy', page: syntheticThingsPage }];
        }
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[0].evidence',
        rule: 'evidence',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[1].evidence',
        rule: 'evidence',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[1].evidence[0]',
        rule: 'evidence',
      },
    ]);
  });

  it('rejects what a read gives without the right when no finding shows it', () => {
    const texts = changed((facts) => {
      const members = facts.operationRights.entries[2];
      if (members !== undefined && 'needs' in members) {
        const need = members.needs[0];
        if (need !== undefined) {
          need.evidence = need.evidence.filter(
            (item) => item.kind === 'openapi',
          );
        }
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[0].evidence',
        rule: 'evidence',
      },
    ]);
  });

  it('rejects a right that an operation both needs and does not need', () => {
    const texts = changed((facts) => {
      const read = facts.operationRights.entries[1];
      if (read !== undefined && 'notNeeded' in read) {
        const item = read.notNeeded?.[0];
        if (item !== undefined) {
          item.right.name = 'view things';
        }
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[1].notNeeded[0].right',
        rule: 'conflict',
      },
    ]);
  });

  it('takes only a finding as evidence that a right is not needed', () => {
    const texts = changed((facts) => {
      const read = facts.operationRights.entries[1];
      if (read !== undefined && 'notNeeded' in read) {
        const item = read.notNeeded?.[0];
        if (item !== undefined) {
          // A description names a right; it never shows one is not needed.
          (item.evidence as unknown[]).push({ kind: 'openapi' });
        }
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'operation-rights.json', path: 'entries[1]', rule: 'format' },
    ]);
  });

  it('takes a read as needing no right only with a finding', () => {
    const texts = changed((facts) => {
      const list = facts.operationRights.entries[3];
      if (list !== undefined && 'none' in list) {
        list.none = [{ kind: 'openapi' }];
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[3].none',
        rule: 'evidence',
      },
    ]);
  });

  it('wants the module where the document names a right whose name repeats', () => {
    const texts = changed((facts) => {
      // Another module with a right of the same name, which the
      // description of the members does not tell apart.
      facts.rights.entries.push({
        module: 'zsynthetic',
        name: 'view thing members',
        kind: 'list',
        pages: [],
      });
      const members = facts.operations.entries[2];
      if (members !== undefined) {
        members.summary = 'List the members of a thing';
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[0].evidence[2]',
        rule: 'evidence',
      },
    ]);
  });

  it('rejects a mark of a link in a text the project writes', () => {
    const texts = changed((facts) => {
      const [unmapped, read] = facts.operationRights.entries;
      if (unmapped !== undefined && 'open' in unmapped) {
        unmapped.open = 'Siehe [Hilfe](javascript:void).';
      }
      if (read !== undefined && 'needs' in read) {
        const evidence = read.needs[0]?.evidence[0];
        if (evidence?.kind === 'finding') {
          evidence.id = 'Befund [x]';
        }
      }
      const label = facts.rights.entries[0]?.label;
      if (label !== undefined) {
        label.text = 'Dinge [bearbeiten]';
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'entries[0].label', rule: 'link' },
      { file: 'operation-rights.json', path: 'entries[0].open', rule: 'link' },
      {
        file: 'operation-rights.json',
        path: 'entries[1].needs[0].evidence[0].id',
        rule: 'link',
      },
    ]);
  });

  it.each(['F0', 'f29', 'F1000'])(
    'rejects %s as the number of a finding',
    (id) => {
      const texts = changed((facts) => {
        const label = facts.rights.entries[0]?.label;
        if (label !== undefined && 'finding' in label) {
          label.finding = id;
        }
      });
      expect(violationsOf(texts)).toEqual([
        { file: 'rights.json', path: 'entries[0].label', rule: 'format' },
      ]);
    },
  );

  it('rejects pairings out of order', () => {
    const texts = changed((facts) => {
      const [first, , members, , post] = facts.operationRights.entries;
      if (members !== undefined && 'needs' in members) {
        members.needs.reverse();
        members.needs[1]?.evidence.reverse();
      }
      if (post !== undefined && 'needs' in post) {
        post.needs[0]?.rights.reverse();
      }
      if (first !== undefined) {
        facts.operationRights.entries.push(first);
      }
    });
    expect(violationsOf(texts)).toEqual([
      {
        file: 'operation-rights.json',
        path: 'entries[5]',
        rule: 'order',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[1]',
        rule: 'order',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[2].needs[1].evidence[1]',
        rule: 'order',
      },
      {
        file: 'operation-rights.json',
        path: 'entries[4].needs[0].rights[1]',
        rule: 'order',
      },
    ]);
  });

  it('rejects an entry with both needs and a note', () => {
    const texts = changed((facts) => {
      const read = facts.operationRights.entries[1];
      if (read !== undefined) {
        Object.assign(read, { open: 'Offen.' });
      }
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'operation-rights.json', path: 'entries[1]', rule: 'format' },
    ]);
  });

  it('collects the findings of every file', () => {
    const texts = {
      ...syntheticFactFiles(),
      'SOURCES.json': '{',
      'academy.json': '[]',
    };
    expect(violationsOf(texts)).toEqual([
      { file: 'SOURCES.json', path: '', rule: 'json' },
      { file: 'academy.json', path: '', rule: 'format' },
    ]);
  });
});

describe('parseFactFiles on foreign content', () => {
  // A host under church.tools other than the placeholder is built at run
  // time, because gitleaks refuses one written out in the repository.
  const hosted = (label: string): string =>
    [label, 'church', 'tools'].join('.');

  function withPageText(text: string): FactFileTexts {
    return changed((facts) => {
      // Added to the text, so that the page still names its rights.
      const page = facts.academy.entries[0];
      if (page !== undefined) {
        page.text = `${page.text}\n\n${text}`;
      }
    });
  }

  it('rejects a foreign host without naming it', () => {
    const texts = changed((facts) => {
      firstOperation(facts).description = `See https://${hosted('gemeinde')}/`;
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'operations.json', path: 'entries[1].description', rule: 'host' },
    ]);
    expect(() => parseFactFiles(texts)).not.toThrow('gemeinde');
  });

  it('rejects a host in the notice of a file', () => {
    const texts = changed((facts) => {
      facts.rights.notice = 'Mehr unter www.vendor.example';
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'rights.json', path: 'notice', rule: 'host' },
    ]);
  });

  it('rejects an image in a description of an operation', () => {
    const texts = changed((facts) => {
      firstOperation(facts).description = 'Siehe ![x](/bild.png)';
    });
    expect(violationsOf(texts)).toEqual([
      { file: 'operations.json', path: 'entries[1].description', rule: 'link' },
    ]);
  });

  it('rejects markup of HTML in a text', () => {
    expect(violationsOf(withPageText('Ein <b>fetter</b> Text'))).toEqual([
      { file: 'academy.json', path: 'entries[0].text', rule: 'html' },
    ]);
  });

  it.each([
    [
      'a link with the host of the Academy',
      '[x](https://churchtools.academy/de/help/)',
    ],
    ['a relative link', '[x](../gruppen/)'],
    ['a link to an e-mail address', '[x](mailto:max.mustermann@example.org)'],
    ['an image', '![Bild](/de/help/bild/)'],
    [
      'a link text over two lines',
      '[ein\nLink](https://churchtools.academy/en/x/)',
    ],
    ['a definition of a link', 'Text [r]\n\n[r]: /de/help/gruppen/'],
    ['an autolink', 'Siehe <https://churchtools.academy/de/help/>'],
    ['a link text over 500 characters', `[${'a'.repeat(501)}](mailto:x)`],
    [
      'a long target that leaves the German pages',
      `[x](/de/${'a'.repeat(497)}/../../en/x/)`,
    ],
  ])('rejects %s in the text of a page', (_name, text) => {
    expect(violationsOf(withPageText(text))).toEqual([
      { file: 'academy.json', path: 'entries[0].text', rule: 'link' },
    ]);
  });

  it.each([
    ['a path', '[x](/de/help/gruppen/)'],
    ['a path with an anchor', '[x](/de/help/gruppen/#rechte)'],
    ['a path without slash at the end', '[x](/de/help/gruppen)'],
  ])('accepts a link with %s', (_name, text) => {
    expect(violationsOf(withPageText(text))).toEqual([]);
  });
});

describe('jsonDepth', () => {
  it('counts objects and arrays without recursion', () => {
    expect(jsonDepth('x')).toBe(0);
    expect(jsonDepth({ a: [1] })).toBe(2);
    expect(
      jsonDepth(JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)),
    ).toBe(maxJsonDepth + 1);
  });
});

describe('shapeDepth', () => {
  it('counts every kind of step', () => {
    expect(shapeDepth({ type: ['string'] })).toBe(0);
    expect(shapeDepth(nest(3))).toBe(3);
    expect(
      shapeDepth({
        properties: [{ name: 'a', required: true, schema: nest(1) }],
      }),
    ).toBe(2);
    expect(shapeDepth({ additionalProperties: true })).toBe(0);
    expect(shapeDepth({ additionalProperties: nest(1) })).toBe(2);
    expect(shapeDepth({ anyOf: [nest(0)], oneOf: [nest(2)] })).toBe(3);
    expect(shapeDepth({ allOf: [nest(1)] })).toBe(2);
  });
});

describe('canonicalJson', () => {
  it('indents by two spaces and ends with a line break', () => {
    expect(canonicalJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });
});
