import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { checkPolicy, defaultPolicy } from './check.js';
import { policyHashOf } from './hash.js';
import type { Policy } from './schema.js';
import { readConfigYaml } from '../config/yaml.js';

const fromYaml = (text: string): Policy => {
  const read = readConfigYaml(text);
  if (!read.ok) throw new Error(read.code);
  const checked = checkPolicy(read.value);
  if (!checked.ok) throw new Error(checked.code);
  return checked.policy;
};

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('policyHashOf', () => {
  // The canonical form written out by hand, so that a change of the form
  // is a decision: an audit line names the policy by this hash.
  it('hashes the canonical form of the default policy', () => {
    expect(policyHashOf(defaultPolicy)).toBe(
      sha256(
        '{"interactive":{"readBudgetPerDay":200,"targets":[]},"schema":"policy.v1","unattended":[]}',
      ),
    );
  });

  it('sorts the keys of every object and writes no spaces', () => {
    const policy = fromYaml(
      [
        'schema: policy.v1',
        'interactive:',
        '  targets:',
        '    - maxPerDay: 4',
        '      tools: [ct_wiki_page_create]',
        '      target: { name: Berichte, id: 12, kind: wiki_category }',
        '',
      ].join('\n'),
    );
    expect(policyHashOf(policy)).toBe(
      sha256(
        '{"interactive":{"readBudgetPerDay":200,"targets":[{"maxPerDay":4,"target":{"id":12,"kind":"wiki_category","name":"Berichte"},"tools":["ct_wiki_page_create"]}]},"schema":"policy.v1","unattended":[]}',
      ),
    );
  });

  it('gives the same hash to the same policy written another way', () => {
    const one = fromYaml(
      [
        '# Policy of the parish',
        'schema: policy.v1',
        'interactive:',
        '  readBudgetPerDay: 200',
        '  targets:',
        '    - target:',
        '        kind: wiki_page',
        '        categoryId: 12',
        '        guid: 00000000-0000-4000-8000-00000000000A',
        '        name: "Résumé"',
        '      tools: [ct_wiki_page_update]',
        '      maxPerDay: 4',
        '',
      ].join('\n'),
    );
    const other = fromYaml(
      JSON.stringify({
        interactive: {
          targets: [
            {
              maxPerDay: 4,
              tools: ['ct_wiki_page_update'],
              target: {
                name: 'Résumé',
                guid: '00000000-0000-4000-8000-00000000000a',
                categoryId: 12,
                kind: 'wiki_page',
              },
            },
          ],
        },
        unattended: [],
        schema: 'policy.v1',
      }),
    );
    expect(policyHashOf(one)).toBe(policyHashOf(other));
  });

  it('changes with a value and with the order of entries', () => {
    const entries = ['wiki_category, id: 12', 'calendar, id: 3'];
    const policyOf = (budget: number, order: readonly string[]): Policy =>
      fromYaml(
        [
          'schema: policy.v1',
          'interactive:',
          `  readBudgetPerDay: ${String(budget)}`,
          '  targets:',
          ...order.map(
            (target) =>
              `    - { target: { kind: ${target}, name: Ziel }, tools: [ct_tool], maxPerDay: 1 }`,
          ),
          '',
        ].join('\n'),
      );
    const base = policyHashOf(policyOf(200, entries));
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(policyHashOf(policyOf(199, entries))).not.toBe(base);
    expect(policyHashOf(policyOf(200, [...entries].reverse()))).not.toBe(base);
  });

  // The line of the marking names whom to ask, so the audit tells which
  // text a write named (ADR 0032).
  it('changes with whom to ask', () => {
    const withInquiries = (inquiriesTo: string): Policy =>
      fromYaml(
        [
          'schema: policy.v1',
          'interactive:',
          `  inquiriesTo: ${inquiriesTo}`,
          '',
        ].join('\n'),
      );
    expect(policyHashOf(withInquiries('Sekretariat'))).not.toBe(
      policyHashOf(withInquiries('Pfarramt')),
    );
    expect(policyHashOf(withInquiries('Sekretariat'))).not.toBe(
      policyHashOf(fromYaml('schema: policy.v1\n')),
    );
  });
});
