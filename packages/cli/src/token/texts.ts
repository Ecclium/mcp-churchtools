/**
 * The German texts of `ecclium token` (ADR 0074). No text repeats an
 * argument as it was given: a word on the command line can hold a token.
 * A name appears only after it passed the check of its form, which no
 * token passes.
 *
 * @packageDocumentation
 */
import type {
  BearerScope,
  BearerTokensCode,
} from '@ecclium/mcp-churchtools-core';

const file = '‹ECCLIUM_HTTP_TOKENS_FILE›';
const check = 'Prüfen Sie die Datei mit ‹ecclium token list›.';

/** Texts for a wrong call of the command and for its fixed outcomes. */
export const tokenTexts = Object.freeze({
  nameInvalid:
    'Der Name des Tokens hat eine andere Form. Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, am Anfang ein Buchstabe, höchstens 32 Zeichen, etwa ‹claude-code-buero›. Ecclium wiederholt den Namen nicht, weil darin ein Token stehen könnte. Wählen Sie einen neutralen Namen, nie den einer Person: Er steht im Audit.',
  daysInvalid:
    '‹--days› nimmt eine ganze Zahl von 1 bis 365 an, ohne Vorzeichen und ohne führende Null. Ohne die Option gilt ein neues Token 180 Tage.',
  nameTaken:
    'Ein Token mit diesem Namen gibt es schon. Es ist nichts geschrieben. Ein Name gehört zu einem Client: Für ein neues Token desselben Clients nehmen Sie ‹ecclium token rotate›, für einen anderen Client einen anderen Namen.',
  nameUnknown:
    'Kein Token in der Datei hat diesen Namen. Es ist nichts geschrieben. ‹ecclium token list› zeigt die Namen.',
  full: 'Die Datei hält schon 64 Einträge, mehr nimmt Ecclium nicht an. Es ist nichts geschrieben. Widerrufen Sie Tokens, die niemand mehr braucht, mit ‹ecclium token revoke›.',
  changed:
    'Die Datei hat sich geändert, während der Befehl lief, vermutlich durch einen zweiten Befehl. Es ist nichts geschrieben, damit keine Änderung verloren geht. Rufen Sie den Befehl noch einmal auf.',
  unsafeFolder: `Der Ordner der Datei aus ${file} gehört einem anderen Benutzer, oder Gruppe und andere Benutzer dürfen darin schreiben, oder an der Stelle der Datei liegt ein Ordner. Es ist nichts geschrieben. Wer dort schreiben darf, könnte die Datei austauschen und damit bestimmen, wer den Server benutzen darf. Geben Sie dem Ordner etwa die Rechte 700 oder 755.`,
  unavailable: `Die Datei aus ${file} konnte nicht geschrieben werden, etwa weil der Ordner fehlt, nur lesbar ist oder die Platte voll ist. Es ist nichts geschrieben. Ecclium zeigt keine Meldung des Systems, weil sie den Pfad nennt. Prüfen Sie den Ordner und rufen Sie den Befehl noch einmal auf.`,
  busy: 'Ein anderer Befehl ‹ecclium token› ändert die Datei gerade. Es ist nichts geschrieben. Rufen Sie den Befehl gleich noch einmal auf. Die Sperre eines Befehls, der abgebrochen ist, übernimmt Ecclium nach einer Minute.',
  tokenNotShown:
    'Das Token konnte nicht ausgegeben werden. In der Datei steht es trotzdem: Widerrufen Sie es mit ‹ecclium token revoke› und legen Sie ein neues an.',
  empty: 'Die Datei enthält kein Token.',
  missingForList: `Die Datei aus ${file} gibt es nicht. Es gibt also kein Token. ‹ecclium token create› legt die Datei mit dem ersten Token an.`,
  missingForChange: `Die Datei aus ${file} gibt es nicht. Es gibt also kein Token, das sich ändern liesse. ‹ecclium token create› legt die Datei mit dem ersten Token an.`,
});

/**
 * One text per code of the file of the tokens, with the field or the line
 * where the problem lies. Neither carries a value of the file: a field is
 * a path of the schema, such as `tokens[2].expiresAt`.
 *
 * @param code - Why the file was refused.
 * @param field - The path of the field, if known.
 * @param line - The line of a problem of YAML, if known.
 * @returns One line for stderr.
 * @example
 * ```ts
 * tokensFileText('bearer_tokens_file_mode');
 * ```
 */
export function tokensFileText(
  code: BearerTokensCode,
  field?: string,
  line?: number,
): string {
  const at =
    field !== undefined
      ? ` (Feld ‹${field}›)`
      : line !== undefined
        ? ` (Zeile ${String(line)})`
        : '';
  switch (code) {
    case 'bearer_tokens_file_relative':
    case 'bearer_tokens_file_platform':
      return `Auf dieser Plattform kann Ecclium nicht prüfen, wem die Datei aus ${file} gehört und wer sie schreiben darf. Ohne diese Prüfung liest Ecclium sie nicht.`;
    case 'bearer_tokens_file_missing':
      return tokenTexts.missingForList;
    case 'bearer_tokens_file_symlink':
      return `Die Datei aus ${file} ist ein symbolischer Link. Ecclium folgt keinem Link, damit niemand die Datei unbemerkt austauscht. Nennen Sie die Datei selbst.`;
    case 'bearer_tokens_file_unreadable':
      return `Die Datei aus ${file} konnte nicht gelesen werden. Ecclium zeigt keine Meldung des Systems, weil sie den Pfad nennt. Prüfen Sie die Rechte des Ordners und der Datei.`;
    case 'bearer_tokens_file_not_regular':
      return `Unter dem Pfad aus ${file} liegt keine gewöhnliche Datei. Nennen Sie die Datei der Tokens, nicht einen Ordner oder ein Gerät.`;
    case 'bearer_tokens_file_owner':
      return `Die Datei aus ${file} gehört einem anderen Benutzer als dem, unter dem Ecclium läuft. Wer die Datei schreiben darf, bestimmt, wer den Server benutzen darf.`;
    case 'bearer_tokens_file_mode':
      return `Gruppe oder andere Benutzer dürfen die Datei aus ${file} ändern. Wer sie schreiben darf, bestimmt, wer den Server benutzen darf. Geben Sie ihr die Rechte 600.`;
    case 'bearer_tokens_file_too_large':
      return `Die Datei aus ${file} ist grösser als 64 KiB. So viel hält eine Datei mit höchstens 64 Tokens nie. ${check}`;
    case 'bearer_tokens_file_bom':
    case 'bearer_tokens_file_encoding':
      return `Die Datei aus ${file} ist kein Text in UTF-8 ohne Byte Order Mark. ${check}`;
    case 'bearer_tokens_file_unsafe':
      return `Die Datei aus ${file} liess sich nicht sicher öffnen. Das Dateisystem meldete einen Fehler, den Ecclium nicht zeigt, weil er den Pfad nennt. Prüfen Sie den Pfad und die Ordner darüber.`;
    case 'bearer_tokens_yaml_syntax':
    case 'bearer_tokens_yaml_unsupported':
      return `Die Datei aus ${file} ist kein YAML, das Ecclium annimmt${at}. Anker, Verweise, Tags und mehrere Dokumente nimmt Ecclium nicht an. ${check}`;
    case 'bearer_tokens_version_unknown':
      return `Die Datei aus ${file} hat nicht die Version 1, die diese Version von Ecclium kennt. ${check}`;
    case 'bearer_tokens_invalid':
      return `Ein Eintrag der Datei aus ${file} hat eine andere Form${at}. Erlaubt sind je Eintrag nur ‹name›, ‹sha256›, ‹scopes›, ‹createdAt› und ‹expiresAt›, und ein Token gilt höchstens 365 Tage. ${check}`;
    case 'bearer_tokens_duplicate':
      return `Zwei Einträge der Datei aus ${file} haben denselben Hash${at}. Ein Token steht höchstens einmal in der Datei. ${check}`;
  }
}

/**
 * A day of the calendar in the German form, such as `25.05.2027`.
 *
 * @param day - A day as `YYYY-MM-DD`.
 * @returns The day as `TT.MM.JJJJ`.
 * @example
 * ```ts
 * germanDay('2027-05-25'); // '25.05.2027'
 * ```
 */
export function germanDay(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}

const scopesText = (scopes: readonly BearerScope[]): string =>
  scopes.includes('write') ? '‹read› und ‹write›' : '‹read›';

/**
 * The line after a new token.
 *
 * @param name - The checked name.
 * @param scopes - Its scopes.
 * @param expiresAt - Its last day.
 * @returns One line for stderr.
 * @example
 * ```ts
 * createdText('claude-code-buero', ['read'], '2027-05-25');
 * ```
 */
export function createdText(
  name: string,
  scopes: readonly BearerScope[],
  expiresAt: string,
): string {
  return `Das Token ‹${name}› ist angelegt, mit den Scopes ${scopesText(scopes)}, gültig bis und mit ${germanDay(expiresAt)} (UTC). Es steht nur in dieser Ausgabe, in keiner Datei: Legen Sie es jetzt beim Client ab.`;
}

/**
 * The line after a rotation.
 *
 * @param name - The checked name.
 * @param expiresAt - The last day of the new token.
 * @param oldExpiresAt - The last day of the old ones, or undefined when
 *   they have expired already.
 * @returns One line for stderr.
 * @example
 * ```ts
 * rotatedText('claude-code-buero', '2027-05-25', '2026-12-03');
 * ```
 */
export function rotatedText(
  name: string,
  expiresAt: string,
  oldExpiresAt: string | undefined,
): string {
  const old =
    oldExpiresAt === undefined
      ? 'Das bisherige war schon abgelaufen.'
      : `Das bisherige gilt noch bis und mit ${germanDay(oldExpiresAt)}, danach nicht mehr.`;
  return `Das neue Token ‹${name}› gilt bis und mit ${germanDay(expiresAt)} (UTC). ${old} Legen Sie das neue jetzt beim Client ab: Es steht nur in dieser Ausgabe.`;
}

/**
 * The line after a revocation.
 *
 * @param name - The checked name.
 * @param removed - How many entries had the name.
 * @returns One line for stderr.
 * @example
 * ```ts
 * revokedText('claude-code-buero', 2);
 * ```
 */
export function revokedText(name: string, removed: number): string {
  const entries = removed === 1 ? '1 Eintrag' : `${String(removed)} Einträge`;
  return `Ab der nächsten Anfrage nimmt der Server kein Token mit dem Namen ‹${name}› mehr an. Entfernt: ${entries}.`;
}

/** The header of `ecclium token list`. */
export const listHeader = [
  'Name',
  'Scopes',
  'erstellt',
  'gilt bis und mit',
  'zuletzt benutzt',
  'Zustand',
];

/**
 * The last use of a token, for `ecclium token list` (ADR 0074): the day the
 * server noted, «nie» when the folder of state holds none, and «unbekannt»
 * without a folder of state or when it could not be read.
 *
 * @param lastUse - The day, `null` when the folder holds none, or
 *   `undefined` when it is unknown.
 * @returns A day or a word.
 * @example
 * ```ts
 * lastUseText('2026-11-26'); // '26.11.2026'
 * lastUseText(undefined); // 'unbekannt'
 * ```
 */
export function lastUseText(lastUse: string | null | undefined): string {
  if (lastUse === undefined) return 'unbekannt';
  if (lastUse === null) return 'nie';
  return germanDay(lastUse);
}

/**
 * The state of a token on a day, for `ecclium token list`. Within 30 days
 * of its last day it says so, as `ecclium doctor` will warn then.
 *
 * @param daysLeft - Whole days from today to its last day, negative after.
 * @returns A few words.
 * @example
 * ```ts
 * stateText(14); // 'läuft in 14 Tagen ab'
 * ```
 */
export function stateText(daysLeft: number): string {
  if (daysLeft < 0) return 'abgelaufen';
  if (daysLeft === 0) return 'gilt nur noch heute';
  if (daysLeft === 1) return 'gilt noch bis morgen';
  if (daysLeft <= 30) return `läuft in ${String(daysLeft)} Tagen ab`;
  return 'gilt';
}
