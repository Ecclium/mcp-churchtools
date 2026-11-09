/**
 * Where a language model may stand without a basis for the transfer, and
 * which bases the configuration takes (ADR 0033).
 *
 * Where it stands in a run: before the run, when the configuration of the
 * providers is loaded, and again when the core wraps a provider, also one
 * of a plugin. Inside Switzerland and the European Economic Area a model
 * needs no basis for the transfer of data; outside, the operator names
 * one from a closed list, and without it no routine starts with that
 * model. Ecclium does not check whether the basis holds; the operator
 * answers for it.
 *
 * @packageDocumentation
 */

/**
 * The codes of ISO 3166-1 alpha-2 of Switzerland and of the countries of
 * the European Economic Area, frozen and sorted: the 27 member states of
 * the European Union, with `GR` for Greece, and Iceland, Liechtenstein
 * and Norway. Every other code, also `EU` and a territory with a code of
 * its own, counts as outside (ADR 0033, Umsetzung).
 */
export const swissAndEeaCountries: readonly string[] = Object.freeze([
  'AT',
  'BE',
  'BG',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]);

/**
 * The bases of a transfer outside Switzerland and the EEA, frozen: a
 * decision on an adequate level of protection, standard contractual
 * clauses and binding corporate rules (ADR 0033).
 */
export const transferBases = Object.freeze([
  'adequacy_decision',
  'standard_contractual_clauses',
  'binding_corporate_rules',
] as const);

/** A basis of a transfer outside Switzerland and the EEA. */
export type TransferBasis = (typeof transferBases)[number];

/** Why a country and a basis do not go together. */
export type TransferBasisProblem =
  'transfer_basis_missing' | 'transfer_basis_needless';

/**
 * Tells whether a code is one of {@link swissAndEeaCountries}, compared
 * exactly.
 *
 * @param code - A code of a country.
 * @returns Whether a model there needs no basis for the transfer.
 * @example
 * ```ts
 * isSwissOrEeaCountry('CH'); // true
 * isSwissOrEeaCountry('US'); // false
 * ```
 */
export function isSwissOrEeaCountry(code: unknown): boolean {
  return swissAndEeaCountries.includes(code as string);
}

/**
 * Checks a country of hosting against the basis of the transfer: outside
 * Switzerland and the EEA one of {@link transferBases} is required, inside
 * none may stand, so that country and basis never say different things.
 *
 * @param country - The code of the country of hosting.
 * @param basis - The basis of the transfer, or undefined.
 * @returns The problem, or undefined when the two go together.
 * @example
 * ```ts
 * checkTransferBasis('US', undefined); // 'transfer_basis_missing'
 * checkTransferBasis('CH', undefined); // undefined
 * ```
 */
export function checkTransferBasis(
  country: string,
  basis: string | undefined,
): TransferBasisProblem | undefined {
  if (isSwissOrEeaCountry(country)) {
    return basis === undefined ? undefined : 'transfer_basis_needless';
  }
  return (transferBases as readonly string[]).includes(basis as string)
    ? undefined
    : 'transfer_basis_missing';
}
