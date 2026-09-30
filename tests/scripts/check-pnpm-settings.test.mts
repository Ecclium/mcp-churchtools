import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  compareSettings,
  configEnvironment,
  expectedSettings,
  undocumentedExceptions,
  unknownWorkspaceKeys,
  unlistedExceptions,
} from '../../scripts/check-pnpm-settings.mts';

describe('compareSettings', () => {
  it('accepts the expected settings', () => {
    expect(compareSettings(expectedSettings)).toEqual([]);
  });

  it('reports a missing setting, as after a misspelt key', () => {
    const rest = Object.fromEntries(
      Object.entries(expectedSettings).filter(
        ([key]) => key !== 'minimumReleaseAge',
      ),
    );
    expect(compareSettings(rest)).toEqual([
      'Einstellung fehlt: minimumReleaseAge (erwartet 4320)',
    ]);
  });

  it('reports a weakened value', () => {
    expect(
      compareSettings({ ...expectedSettings, trustPolicy: 'off' }),
    ).toEqual(['Einstellung trustPolicy ist "off", erwartet "no-downgrade"']);
  });

  it('allows exceptions from the release age only for exact versions', () => {
    const exact = {
      minimumReleaseAgeExclude: ['@scope/fix@1.2.3', 'fix@2.0.1'],
    };
    expect(compareSettings({ ...expectedSettings, ...exact })).toEqual([]);
    const loose = { minimumReleaseAgeExclude: ['fix', '@scope/*'] };
    expect(compareSettings({ ...expectedSettings, ...loose })).toHaveLength(2);
  });

  it('allows build entries only to keep scripts disabled', () => {
    const off = { allowBuilds: { fsevents: false } };
    expect(compareSettings({ ...expectedSettings, ...off })).toEqual([]);
    const on = { allowBuilds: { esbuild: true } };
    expect(compareSettings({ ...expectedSettings, ...on })).toEqual([
      'allowBuilds darf keine Install-Skripte erlauben, auch nicht für esbuild',
    ]);
  });
});

describe('unknownWorkspaceKeys', () => {
  it('finds a misspelt top-level key and skips comments and lists', () => {
    const yaml = [
      '# minimumReleaseAge: 1',
      'packages:',
      '  - packages/*',
      'minimumReleaseAge: 4320',
      'minimumReleseAge: 4320',
      'allowBuilds:',
      '  fsevents: false',
    ].join('\n');
    expect(unknownWorkspaceKeys(yaml)).toEqual(['minimumReleseAge']);
  });

  it('finds nothing unknown and every protection in pnpm-workspace.yaml', () => {
    const yaml = readFileSync(
      new URL('../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    expect(unknownWorkspaceKeys(yaml)).toEqual([]);
    for (const key of Object.keys(expectedSettings)) {
      expect(yaml).toMatch(new RegExp(`^${key}:`, 'm'));
    }
  });
});

describe('undocumentedExceptions', () => {
  const workspace = (...exclude: string[]): string =>
    ['packages:', '  - packages/*', ...exclude, 'minimumReleaseAge: 4320'].join(
      '\n',
    );

  it('accepts no exceptions and exceptions with date and reason', () => {
    expect(
      undocumentedExceptions(workspace('minimumReleaseAgeExclude: []')),
    ).toEqual([]);
    expect(
      undocumentedExceptions(
        workspace(
          'minimumReleaseAgeExclude:',
          '  # 29.09.2026: security fix for a parser, advisory published today',
          '  - fix@1.2.4',
          '  # 2026-09-30 same advisory, second package',
          '  - "@scope/fix@2.0.1"',
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ['without a comment', ['  - fix@1.2.4']],
    ['with a comment that has no date', ['  # security fix', '  - fix@1.2.4']],
    ['with a date but no reason', ['  # 29.09.2026', '  - fix@1.2.4']],
    [
      'with the comment separated by a blank line',
      ['  # 29.09.2026: security fix', '', '  - fix@1.2.4'],
    ],
    ['in the first column', ['- fix@1.2.4']],
  ])('reports an exception %s', (_, lines) => {
    expect(
      undocumentedExceptions(workspace('minimumReleaseAgeExclude:', ...lines)),
    ).toEqual([expect.stringContaining('"fix@1.2.4"')]);
  });

  it('reports each undocumented exception of several', () => {
    expect(
      undocumentedExceptions(
        workspace(
          'minimumReleaseAgeExclude:',
          '  # 29.09.2026: security fix',
          '  - fix@1.2.4',
          '  - other@3.0.1',
        ),
      ),
    ).toEqual([expect.stringContaining('"other@3.0.1"')]);
  });

  it('rejects exceptions in brackets, as Renovate might write them', () => {
    expect(
      undocumentedExceptions(
        workspace('minimumReleaseAgeExclude: [fix@1.2.4]'),
      ),
    ).toEqual([expect.stringContaining('eckigen Klammern')]);
  });

  it('finds nothing in pnpm-workspace.yaml', () => {
    const yaml = readFileSync(
      new URL('../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    expect(undocumentedExceptions(yaml)).toEqual([]);
  });
});

describe('unlistedExceptions', () => {
  const dated = [
    'minimumReleaseAgeExclude:',
    '  # 29.09.2026: security fix for a parser',
    '  - fix@1.2.4',
    '  # 29.09.2026: same advisory, second package',
    "  - '@scope/fix@2.0.1'",
  ].join('\n');

  it('accepts what pnpm applies when every entry is written as a line', () => {
    expect(
      unlistedExceptions(dated, ['fix@1.2.4', '@scope/fix@2.0.1']),
    ).toEqual([]);
    expect(unlistedExceptions('minimumReleaseAgeExclude: []', [])).toEqual([]);
  });

  it('reports an exception that pnpm applies but the text does not show', () => {
    // YAML also allows a quoted key, which the reading of the text does not
    // follow. pnpm still applies the exception.
    const quoted = ['"minimumReleaseAgeExclude":', '  - fix@1.2.4'].join('\n');
    expect(undocumentedExceptions(quoted)).toEqual([]);
    expect(unlistedExceptions(quoted, ['fix@1.2.4'])).toEqual([
      expect.stringContaining('"fix@1.2.4" gilt für pnpm'),
    ]);
    expect(
      unlistedExceptions('minimumReleaseAgeExclude: []', ['other@3.0.1']),
    ).toEqual([expect.stringContaining('"other@3.0.1"')]);
  });

  it('leaves a list in brackets to undocumentedExceptions', () => {
    expect(
      unlistedExceptions('minimumReleaseAgeExclude: [fix@1.2.4]', [
        'fix@1.2.4',
      ]),
    ).toEqual([]);
  });
});

describe('configEnvironment', () => {
  const inherited = {
    pnpm_config_verify_deps_before_run: 'false',
    npm_config_verify_deps_before_run: 'false',
    pnpm_config_minimum_release_age: '0',
  };

  it('removes only the override that pnpm passes to its scripts', () => {
    expect(
      configEnvironment({ ...inherited, npm_lifecycle_event: 'check' }),
    ).toEqual({
      pnpm_config_minimum_release_age: '0',
      npm_lifecycle_event: 'check',
    });
  });

  it('keeps every override outside of pnpm run', () => {
    expect(configEnvironment(inherited)).toEqual(inherited);
  });
});
