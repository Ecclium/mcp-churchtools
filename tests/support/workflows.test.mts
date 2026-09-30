import { describe, expect, it } from 'vitest';

import { runValues } from './workflows.mts';

// The checks of the secret scans read every run: value as the runner and
// lefthook see it. A value this reader would read only in part must fail
// instead, or a check could pass for a command that CI does not run.
describe('runValues', () => {
  it('reads a plain value and a literal block', () => {
    const yaml = [
      'steps:',
      '  - name: One',
      '    run: echo one',
      '  - name: Two',
      '    run: |',
      '      echo two',
      '',
      '      echo three',
      '  - name: Three',
      '',
    ].join('\n');
    expect(runValues(yaml, 'test')).toEqual([
      'echo one',
      'echo two\n\necho three\n',
    ]);
  });

  it('skips the defaults of a workflow, which hold no command', () => {
    const yaml = ['defaults:', '  run:', '    # a comment', '    shell: bash'];
    expect(runValues(yaml.join('\n'), 'test')).toEqual([]);
  });

  it('refuses a value that goes on over more lines', () => {
    const yaml = ['    run: printf one |', '      gitleaks stdin'];
    expect(() => runValues(yaml.join('\n'), 'test')).toThrow(/cannot read/);
  });

  it('refuses quoted and folded values', () => {
    for (const value of ["'echo one'", '"echo one"', '>', '|-', '|2']) {
      expect(() => runValues(`run: ${value}\n  echo\n`, 'test')).toThrow(
        /cannot read/,
      );
    }
  });
});
