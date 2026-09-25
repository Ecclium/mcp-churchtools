import { describe, expect, it } from 'vitest';

import {
  countPackages,
  developmentLicences,
  findViolations,
  isAllowed,
  runtimeLicences,
  type LicenceReport,
} from '../../scripts/check-licenses.mts';

describe('isAllowed', () => {
  it.each([
    ['MIT', true],
    ['(MIT OR GPL-3.0-only)', true],
    ['MIT AND Apache-2.0', true],
    ['((MIT OR ISC) AND BSD-3-Clause)', true],
    ['MIT AND GPL-3.0-only', false],
    ['GPL-3.0-only', false],
    ['Apache-2.0 WITH LLVM-exception', false],
    ['UNLICENSED', false],
    ['', false],
    ['MIT OR', false],
    ['(MIT', false],
    ['MIT)', false],
    ['MIT ISC', false],
  ])('%j is allowed at run time: %s', (expression, expected) => {
    expect(isAllowed(expression, runtimeLicences)).toBe(expected);
  });

  it('allows the weaker licences only for development', () => {
    for (const licence of ['MPL-2.0', 'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0']) {
      expect(isAllowed(licence, runtimeLicences)).toBe(false);
      expect(isAllowed(licence, developmentLicences)).toBe(true);
    }
  });
});

describe('findViolations', () => {
  const report: LicenceReport = {
    MIT: [{ name: 'fine', versions: ['1.0.0'], license: 'MIT' }],
    'GPL-3.0-only': [
      {
        name: 'copyleft',
        versions: ['2.0.0', '1.0.0'],
        license: 'GPL-3.0-only',
      },
    ],
    'MPL-2.0': [{ name: 'weak', versions: ['3.0.0'], license: 'MPL-2.0' }],
  };

  it('names every version with a licence that is not allowed', () => {
    expect(findViolations(report, runtimeLicences)).toEqual([
      'copyleft@1.0.0 (GPL-3.0-only)',
      'copyleft@2.0.0 (GPL-3.0-only)',
      'weak@3.0.0 (MPL-2.0)',
    ]);
    expect(findViolations(report, developmentLicences)).toEqual([
      'copyleft@1.0.0 (GPL-3.0-only)',
      'copyleft@2.0.0 (GPL-3.0-only)',
    ]);
  });

  it('counts package versions', () => {
    expect(countPackages(report)).toBe(4);
    expect(countPackages({})).toBe(0);
  });
});
