import { describe, expect, it } from 'vitest';

import {
  checkTransferBasis,
  isSwissOrEeaCountry,
  swissAndEeaCountries,
  transferBases,
} from './countries.js';

describe('the countries of Switzerland and the EEA', () => {
  it('are 31 codes, sorted, unique and frozen', () => {
    expect(swissAndEeaCountries).toHaveLength(31);
    expect(new Set(swissAndEeaCountries).size).toBe(31);
    expect([...swissAndEeaCountries].sort()).toEqual(swissAndEeaCountries);
    expect(Object.isFrozen(swissAndEeaCountries)).toBe(true);
    for (const code of swissAndEeaCountries) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it.each(['CH', 'DE', 'AT', 'GR', 'IS', 'LI', 'NO', 'SE'])(
    'count %s as inside',
    (code) => {
      expect(isSwissOrEeaCountry(code)).toBe(true);
    },
  );

  it.each(['US', 'GB', 'EL', 'EU', 'FO', 'GI', 'ch', '', undefined])(
    'count %j as outside',
    (code) => {
      expect(isSwissOrEeaCountry(code)).toBe(false);
    },
  );
});

describe('checkTransferBasis', () => {
  it('has three bases, frozen', () => {
    expect(transferBases).toEqual([
      'adequacy_decision',
      'standard_contractual_clauses',
      'binding_corporate_rules',
    ]);
    expect(Object.isFrozen(transferBases)).toBe(true);
  });

  it.each(transferBases)('takes %s outside', (basis) => {
    expect(checkTransferBasis('US', basis)).toBeUndefined();
  });

  it('takes no basis inside', () => {
    expect(checkTransferBasis('CH', undefined)).toBeUndefined();
  });

  it.each([undefined, 'consent', 'eu_gdpr', ''])(
    'refuses %j outside',
    (basis) => {
      expect(checkTransferBasis('US', basis)).toBe('transfer_basis_missing');
    },
  );

  it('refuses a basis inside, so that country and basis agree', () => {
    expect(checkTransferBasis('DE', 'adequacy_decision')).toBe(
      'transfer_basis_needless',
    );
  });
});
