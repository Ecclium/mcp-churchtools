import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  compareSettings,
  configEnvironment,
  expectedSettings,
  unknownWorkspaceKeys,
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
