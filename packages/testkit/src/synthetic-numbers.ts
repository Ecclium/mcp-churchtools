/**
 * IBAN and AHV numbers from synthetic digits for tests of the check of
 * free text (ADR 0069). Each number gets its check sum or check digit
 * here, at run time, so that no test file holds a value that has the form
 * of a real number and the scan for secrets has nothing to report.
 *
 * @packageDocumentation
 */

/**
 * An IBAN of a country with the given letters and digits after the check
 * digits, which this computes after ISO 7064: the rest, the letters of the
 * country and `00`, every letter as two digits, leave a remainder when
 * divided by 97, and the check digits are 98 less that remainder.
 *
 * @param country - Two upper-case letters, such as `CH`.
 * @param rest - Upper-case letters and digits after the check digits.
 * @returns The IBAN in one run, without spaces.
 * @example
 * ```ts
 * ibanOf('CH', '00000000000000012'); // an IBAN of 21 characters
 * ```
 */
export function ibanOf(country: string, rest: string): string {
  let remainder = 0;
  for (const character of `${rest}${country}00`) {
    const code = character.charCodeAt(0);
    const value = code >= 0x41 ? code - 0x41 + 10 : code - 0x30;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return `${country}${String(98 - remainder).padStart(2, '0')}${rest}`;
}

/**
 * An IBAN as it is printed: groups of four with one space between them.
 *
 * @param iban - An IBAN in one run.
 * @returns The printed form.
 * @example
 * ```ts
 * printedIban(ibanOf('CH', '00000000000000012')); // groups of four
 * ```
 */
export function printedIban(iban: string): string {
  const groups: string[] = [];
  for (let start = 0; start < iban.length; start += 4) {
    groups.push(iban.slice(start, start + 4));
  }
  return groups.join(' ');
}

/**
 * An AHV number from nine synthetic digits after 756, with the check digit
 * of EAN-13: the first twelve digits weighted 1 and 3 in turn, and the
 * last brings their sum to a multiple of ten.
 *
 * @param nine - Nine digits.
 * @returns The number in one run of thirteen digits.
 * @example
 * ```ts
 * ahvOf('000000001'); // 756, the nine digits and the check digit
 * ```
 */
export function ahvOf(nine: string): string {
  const twelve = `756${nine}`;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(twelve.charAt(index)) * (index % 2 === 0 ? 1 : 3);
  }
  return `${twelve}${String((10 - (sum % 10)) % 10)}`;
}

/**
 * An AHV number as it is printed, in the groups 3, 4, 4 and 2 with one
 * separator between them.
 *
 * @param ahv - An AHV number in one run.
 * @param separator - A dot, a space or a hyphen.
 * @returns The printed form.
 * @example
 * ```ts
 * groupedAhv(ahvOf('000000001'), '.'); // 756.0000.0000.0x
 * ```
 */
export function groupedAhv(ahv: string, separator: '.' | ' ' | '-'): string {
  return [
    ahv.slice(0, 3),
    ahv.slice(3, 7),
    ahv.slice(7, 11),
    ahv.slice(11),
  ].join(separator);
}
