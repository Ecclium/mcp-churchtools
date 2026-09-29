import { describe, expect, it } from 'vitest';

import { checkTitle } from '../../scripts/ci/check-pr-title.mts';

describe('checkTitle', () => {
  it.each([
    'fix: reject tokens without prefix',
    'docs(adr): record the node line',
    'feat(core)!: drop the old configuration keys',
    'ci: add the workbench and supply-chain checks',
    // Titles in the form Renovate writes them.
    'chore(deps): update dependency vitest to v5.0.2',
    'chore(deps): update actions/checkout action to v7.1.0',
    'chore(deps): update node.js to v24.22.0',
    'fix(deps): update dependency zod to v4.6.6 [SECURITY]',
    'chore(deps): lock file maintenance',
  ])('accepts «%s»', (title) => {
    expect(checkTitle(title)).toEqual([]);
  });

  it.each([
    ['Update README', 'Conventional Commits'],
    ['fix reject tokens', 'Conventional Commits'],
    ['fix:reject tokens', 'Conventional Commits'],
    ['Fix: reject tokens', 'Conventional Commits'],
    ['bump: update pnpm', 'Typ «bump»'],
    ['fix(Core): reject tokens', 'Bereich'],
    ['fix(): reject tokens', 'Bereich'],
    ['fix: ', 'Leerraum'],
    ['fix:  reject tokens', 'genau ein Leerzeichen'],
    [' fix: reject tokens', 'Leerraum'],
  ])('rejects «%s»', (title, reason) => {
    const problems = checkTitle(title);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(reason);
  });

  it('reports every problem of a title that has a header', () => {
    expect(checkTitle('bump(X): update')).toHaveLength(2);
  });

  it.each([
    ['a line break', 'fix: reject tokens\nSigned-off-by: someone'],
    ['a carriage return', 'fix: reject tokens\r'],
    ['a direction override', 'fix: reject \u202eenekot'],
    ['a zero-width space', 'fix: reject\u200btokens'],
    ['a byte order mark', '\ufefffix: reject tokens'],
  ])('rejects a title with %s', (_, title) => {
    expect(checkTitle(title)).toEqual([
      expect.stringContaining('Steuerzeichen'),
    ]);
  });

  it('does not repeat the title in its messages', () => {
    // A line of the log that starts with :: is a command to the runner, so
    // text from a pull request must never be echoed.
    for (const problem of checkTitle('Update from ::warning::somewhere')) {
      expect(problem).not.toContain('::');
    }
  });
});
