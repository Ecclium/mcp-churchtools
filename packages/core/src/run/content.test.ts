import { ibanOf } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { checkPolicy, defaultPolicy } from '../policy/check.js';
import { sealRedacted } from '../redaction/redacted.js';
import {
  checkRunSection,
  checkRunText,
  escapeRunText,
  runContactKeys,
} from './content.js';

// The content policy for what a run writes (ADR 0030, ADR 0033).

describe('a text field of a run', () => {
  it('passes as one line of plain text in its normal form', () => {
    expect(checkRunText('Ｓigrist fehlt', new Set())).toEqual({
      ok: true,
      text: 'Sigrist fehlt',
    });
  });

  it('is refused with a link, a pseudonym, a line break or an unknown contact', () => {
    const refused = (text: string) => {
      const result = checkRunText(text, new Set());
      return result.ok ? [] : result.violations;
    };
    expect(refused('Mehr unter gemeinde.example')).toContain('webAddress');
    expect(refused(`Dienst von p1_${'a'.repeat(39)}`)).toContain('masked');
    expect(refused('Zeile\nzwei')).toContain('unsupported');
    expect(refused('[hier](https://example.org)')).toContain('unsupported');
    expect(refused('Telefon 000 000 12 34')).toContain('contact');
  });

  it('may hold a contact value it was given', () => {
    const keys = new Set(['0000001234']);
    expect(checkRunText('Telefon 000 000 12 34', keys).ok).toBe(true);
  });
});

describe('a section of a run', () => {
  it('passes in the form to write and refuses a link', () => {
    expect(checkRunSection('## Woche\n* Sigrist fehlt', new Set())).toEqual({
      ok: true,
      text: '## Woche\n\n- Sigrist fehlt\n',
    });
    expect(
      checkRunSection('Mehr: [hier](https://example.org)', new Set()),
    ).toEqual({ ok: false, violations: ['link'] });
  });
});

describe('a text set as plain text', () => {
  it('escapes every sign of punctuation of ASCII', () => {
    expect(escapeRunText('# 1. *Probe* | [x] _a_ <b> `c` \\ ~ ! ok')).toBe(
      '\\# 1\\. \\*Probe\\* \\| \\[x\\] \\_a\\_ \\<b\\> \\`c\\` \\\\ \\~ \\! ok',
    );
    expect(escapeRunText('Äpfel und Birnen')).toBe('Äpfel und Birnen');
  });

  it('marks nothing up in a section, wherever it stands', () => {
    for (const text of [
      '# Titel',
      '- Punkt',
      '1. Punkt',
      '> Zitat',
      '**fett**',
      'a | b',
    ]) {
      const section = checkRunSection(`${escapeRunText(text)}\n`, new Set());
      expect(section.ok).toBe(true);
      if (!section.ok) continue;
      expect(section.text.startsWith('#')).toBe(false);
      expect(section.text.startsWith('-')).toBe(false);
      expect(section.text.startsWith('>')).toBe(false);
      expect(section.text).not.toMatch(/^\d+\. /u);
      expect(section.text).not.toContain('**fett**');
    }
  });
});

describe('the contact values a run may write', () => {
  const policy = checkPolicy({
    schema: 'policy.v1',
    interactive: { contacts: ['Info@example.org'] },
  });
  if (!policy.ok) throw new Error('the policy of the test is invalid');

  it('are those of the policy and those in the data of the model', () => {
    const iban = ibanOf('CH', '00000000000000012');
    const keys = runContactKeys(policy.policy, [
      sealRedacted({ notes: [{ text: `Konto ${iban}` }], count: 2 }),
      'Telefon 000 000 12 34',
      null,
    ]);
    expect([...keys].sort()).toEqual(
      ['0000001234', iban, 'info@example.org'].sort(),
    );
  });

  it('are none without a list in the policy and without contacts in the data', () => {
    expect(runContactKeys(defaultPolicy, [{ text: 'Plan' }]).size).toBe(0);
  });

  it('pass over a text the content policy cannot read', () => {
    expect(runContactKeys(defaultPolicy, ['\uD800']).size).toBe(0);
  });
});
