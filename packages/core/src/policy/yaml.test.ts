import { describe, expect, it } from 'vitest';

import { readPolicyYaml } from './yaml.js';

describe('readPolicyYaml', () => {
  it('reads a map of YAML 1.2 into plain values', () => {
    const result = readPolicyYaml(
      [
        'schema: policy.v1',
        '# A comment of the operator.',
        'interactive:',
        '  readBudgetPerDay: 150',
        '  targets:',
        '    - target: { kind: wiki_category, id: 12, name: "Berichte" }',
        '      tools: [ct_wiki_page_create]',
        '      maxPerDay: 4',
        '',
      ].join('\n'),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        schema: 'policy.v1',
        interactive: {
          readBudgetPerDay: 150,
          targets: [
            {
              target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
              tools: ['ct_wiki_page_create'],
              maxPerDay: 4,
            },
          ],
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('reads JSON as well', () => {
    expect(
      readPolicyYaml('{"schema": "policy.v1", "interactive": {}}'),
    ).toEqual({
      ok: true,
      value: { schema: 'policy.v1', interactive: {} },
    });
  });

  it('reads the words of YAML 1.1 as text, not as booleans', () => {
    expect(readPolicyYaml('a: yes\nb: off\n')).toEqual({
      ok: true,
      value: { a: 'yes', b: 'off' },
    });
  });

  it('keeps a key named __proto__ as an own key, so that the schema refuses it', () => {
    const result = readPolicyYaml('__proto__: {polluted: 1}\n');
    expect(result.ok).toBe(true);
    const value = (result as { readonly value: object }).value;
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect('polluted' in {}).toBe(false);
  });

  it('leaves << as a plain key, because merge keys are off', () => {
    expect(readPolicyYaml('a:\n  <<: {b: 1}\n')).toEqual({
      ok: true,
      value: { a: { '<<': { b: 1 } } },
    });
  });

  it.each([
    ['a key twice in one map', 'a: 1\na: 2\n', 2],
    ['a second document', 'a: 1\n---\nb: 2\n', 2],
    ['a flow that does not end', 'a: [1, 2\nb: 3\n', 2],
    ['a tag the schema does not know', 'a: 1\nb: !foo x\n', 2],
  ])('refuses %s as a syntax error with its line', (_name, text, line) => {
    expect(readPolicyYaml(text)).toEqual({
      ok: false,
      code: 'policy_yaml_syntax',
      line,
    });
  });

  it('refuses a text nested without end', () => {
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    expect(readPolicyYaml(deep)).toMatchObject({
      ok: false,
      code: 'policy_yaml_syntax',
    });
  });

  it.each([
    ['an anchor', 'a: 1\nb: &x 2\n', 2],
    ['an anchor with its alias', 'a: &x 1\nb: *x\n', 1],
    ['an alias without its anchor', 'a: 1\nb: *x\n', 2],
    ['a tag of the schema', 'a: 1\nb: !!str 12\n', 2],
    // The line where the map starts, after its tag.
    ['a tag on a map', '!!map\na: 1\n', 2],
    ['a number as key', 'a: 1\n2: b\n', 2],
    ['a boolean as key', 'true: b\n', 1],
    ['an empty key', 'a: 1\n: b\n', 2],
    ['a list as key', 'a: 1\n? [x]\n: c\n', 2],
  ])('refuses %s as not supported, with its line', (_name, text, line) => {
    expect(readPolicyYaml(text)).toEqual({
      ok: false,
      code: 'policy_yaml_unsupported',
      line,
    });
  });

  // The document keeps no position of a directive, so the code alone.
  it.each([
    ['the version 1.1', '%YAML 1.1\n---\na: yes\n'],
    [
      'the version 1.2 named, after comments',
      '# c\n# c\n%YAML 1.2\n---\na: 1\n',
    ],
    ['a handle of its own', '%TAG !e! tag:example.org,2026:\n---\na: 1\n'],
    ['another meaning of !!', '%TAG !! tag:example.org,2026:\n---\na: 1\n'],
  ])('refuses %s as not supported, without a line', (_name, text) => {
    expect(readPolicyYaml(text)).toEqual({
      ok: false,
      code: 'policy_yaml_unsupported',
    });
  });

  it('refuses a value that is not a string', () => {
    expect(() => readPolicyYaml(12 as unknown as string)).toThrow(TypeError);
  });
});
