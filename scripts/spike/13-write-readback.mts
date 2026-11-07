/**
 * Probe 13: the form in which ChurchTools stores the text of a wiki page,
 * and what a read of an appointment holds beyond the OpenAPI document.
 *
 * The server of Ecclium compares what it reads right after a write with
 * what it sent, exactly (ADR 0029). This probe shows what the instance
 * makes of the texts the server sends and what it adds to an appointment
 * the server writes, so that the server can send and compare the same.
 *
 * Runs only with the write account, with the probe calendar and the probe
 * resource from the environment, and writes only after the guard of the
 * test environment has passed and a person has typed «ja» (ADR 0049).
 * Writes, in the write area and the probe calendar only:
 * - `POST /api/wiki/categories/{id}/pages`: one Markdown page whose text
 *   has the form the server sends, paragraphs and the line of the marking
 *   with a line break at the end; then `PATCH …/pages/{guid}` once for each
 *   case below, each with a text that differs from the one before in its
 *   first sentence and at its ends; last `DELETE` of the page;
 * - `POST /api/calendars/{id}/appointments`: one appointment with exactly
 *   the fields the server sends, fifteen days ahead from 12:00 to 13:00
 *   UTC; then `PUT` with exactly the fields the server sends for a change,
 *   with a new title and a new description; last `DELETE`.
 * No booking, so the managers of the resource get no mail.
 * No request carries a CSRF token or a cookie.
 * Reads: what the guard reads; after each write of the wiki the page and
 * its versions; the appointment as the server reads it before a change,
 * with `include[]` for event, bookings and invitations, and once without.
 * Records: the page and the appointment in the two write state files, the
 * moment the instance confirms them. After an error that follows a write
 * it sends nothing more but the deletions of its cleanup; what stays,
 * 07-wiki-cleanup and 11-calendar-write remove with the same files.
 * Answers: which characters the instance removes at the ends of a text,
 * and whether it changes anything else; which keys a read of an
 * appointment holds that the server does not know, what their texts are
 * like, whether the rules of the server count them as linked, and whether
 * a change with the fields of the server keeps them. It prints status
 * codes, fixed words, count classes and the names of those keys. A name
 * appears only in the form of an identifier and only if the block list
 * lets it through; else it says «zurückgehalten». No value appears.
 *
 * Between two writes it waits a little longer than a second: the instance
 * gives the time of the last change in whole seconds, so two writes in the
 * same second would look like none.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import { SpikeError } from './lib/errors.mts';
import { pageTitlePrefix, passGate, rightsStillWithin } from './lib/gate.mts';
import type { Guard, Json } from './lib/guard.mts';
import {
  appointmentIncludes,
  guidPattern,
  pathFor,
  writeTemplate,
  type CalendarArea,
  type Client,
  type ProbeResponse,
  type WriteClient,
  type WriteOperation,
} from './lib/http.mts';
import { calendarOperations, operations } from './lib/operations.mts';
import { dataOf, readPage, type PageView } from './lib/pages.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import {
  Schemas,
  findOperation,
  isObject,
  type JsonObject,
  type OpenApiDocument,
} from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';
import {
  CalendarStateFile,
  WriteStateFile,
  checkNewWriteState,
} from './lib/write-state.mts';

/** The names of the classes of characters at the ends of a text. */
const spaceClasses: readonly (readonly [string, string])[] = [
  [' ', 'Leerzeichen'],
  ['\t', 'Tabulator'],
  ['\n', 'Zeilenumbruch'],
  ['\r', 'Wagenrücklauf'],
  ['\u000B', 'vertikaler Tabulator'],
  ['\u000C', 'Seitenvorschub'],
  ['\u00A0', 'geschütztes Leerzeichen'],
  ['\u3000', 'ideografisches Leerzeichen'],
];

const otherCharacter = 'anderes Zeichen';

/** The places of a key the server does not know. */
const places = {
  data: 'neben dem Termin',
  appointment: 'im Termin',
  date: 'in einem Datum',
} as const;

/** The parts beside a link that the server counts as linked to a date. */
const partWords = [
  'Serie',
  'Adresse',
  'Link',
  'Bild',
  'Anmeldung',
  'im Auftrag',
] as const;

const words = [
  'probe',
  '13-write-readback',
  'wiki',
  'termin',
  'anlegen',
  'antwort',
  'status',
  'faelle',
  'nicht ausgeführt',
  'version',
  'neu',
  'gleich',
  'andere',
  'zurueckgelesen',
  'wie gesendet',
  'ohne Leerraum an den Enden',
  'Zeilenenden zu LF, ohne Leerraum an den Enden',
  'anders',
  'unbekannt',
  'entferntAnfang',
  'entferntEnde',
  'laengeDifferenz',
  'zeilenenden',
  'LF',
  'CRLF',
  'gemischt',
  'keine',
  'regel',
  'wie trim in PHP',
  'wie trim in JavaScript',
  'keine der beiden',
  'loeschen',
  'danachLesen',
  'angelegt',
  'lesen',
  'lesenOhneInclude',
  'struktur',
  'unbekannt',
  'ort',
  'name',
  'zurückgehalten',
  'typ',
  'Objekt',
  'Liste',
  'Text',
  'Zahl',
  'Wahrheitswert',
  'null',
  'verweis',
  'alteFeldnamen',
  'felder',
  'form',
  'leer',
  'Adresse dieser Instanz',
  'Adresse',
  'Pfad',
  'gleichWie',
  'nenntKennung',
  'regelnDesServers',
  'zusatzinfos',
  'datumMitVerweis',
  'unbekanntNebenTermin',
  'unbekanntImTermin',
  'weitereTeile',
  'verknuepft',
  'aendern',
  'versionDifferenz',
  'eins',
  'zwei',
  'mehr',
  'nachAenderung',
  'ergebnis',
  'fehlt',
  'folgtTitel',
  'aufraeumen',
  'seite',
  'gelöscht',
  'übrig',
  'rechteUnveraendert',
  'ja',
  'nein',
  otherCharacter,
  ...spaceClasses.map(([, name]) => name),
  ...Object.values(places),
  ...partWords,
];

const summary =
  '13-write-readback legt im Schreibbereich eine Seite an, ändert ihren Text achtmal und löscht sie, und im Kalender der Proben einen Termin, den es einmal ändert und löscht. Es legt keine Buchung an, ChurchTools schickt also keine Mail an die Verwalter der Ressource.';

/** A little more than a second, see the module comment. */
const pauseBeforeWrite = 1100;

/** How many days ahead the probe writes its appointment. */
const daysAhead = 15;

// The form of a key that may appear under its name, as in structure.mts.
const identifierKey = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * Finds the day of the appointment, fifteen days after today in UTC, and
 * its times from 12:00 to 13:00 UTC: never at midnight in the time zones of
 * the German-speaking countries, and on another day than the smoke test for
 * writing, which writes fourteen days ahead.
 *
 * @param now - The current time.
 * @returns The day and the start and end of the appointment.
 * @example
 * ```ts
 * readbackTimes(new Date('2026-11-07T20:00:00Z'));
 * // { day: '2026-11-22', start: '2026-11-22T12:00:00Z', end: '2026-11-22T13:00:00Z' }
 * ```
 */
export function readbackTimes(now: Date): {
  readonly day: string;
  readonly start: string;
  readonly end: string;
} {
  const day = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysAhead,
    ),
  )
    .toISOString()
    .slice(0, 10);
  return { day, start: `${day}T12:00:00Z`, end: `${day}T13:00:00Z` };
}

/**
 * Writes a synthetic text in the form in which the server of Ecclium sends
 * one: paragraphs with emphasis, quotes and an escaped sign, a list, and
 * last the line of the marking in its fixed wording, joined by line breaks
 * and without anything at the ends.
 *
 * @param day - The day the line of the marking names, `YYYY-MM-DD`.
 * @param variant - A word that makes this text differ from the others.
 * @param lineBreak - The line break between the lines.
 * @returns The text.
 */
export function coreFormText(
  day: string,
  variant: string,
  lineBreak = '\n',
): string {
  const named = `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
  return [
    `Ablauf der Probe für das Zurücklesen, ${variant}.`,
    '',
    '**Fett**, *kursiv* und «Anführungszeichen», mit ss statt Eszett, 5 \\* 3 Stühle.',
    '',
    '- Erster Punkt',
    '- Zweiter Punkt',
    '',
    `Automatisch erstellt am ${named} durch Ecclium, interaktiv, Prüfcode k1:ABCDEFGHIJKLM. Rückfragen an Sekretariat.`,
  ].join(lineBreak);
}

/** One case of the wiki: what the text gets at its start and at its end. */
export interface WikiCase {
  /** The key of the case in the output. */
  readonly name: string;
  readonly start: string;
  readonly end: string;
  /** Whether the lines are joined with CR LF instead of LF. */
  readonly crlf: boolean;
}

/** The text the first write sends ends as the server's does. */
export const createCase: WikiCase = Object.freeze({
  name: 'anlegen',
  start: '',
  end: '\n',
  crlf: false,
});

/** The changes after the first write, in this order. */
export const wikiCases: readonly WikiCase[] = Object.freeze([
  {
    name: 'endeLeerzeichenUndUmbrueche',
    start: '',
    end: '  \n\n',
    crlf: false,
  },
  { name: 'anfangUmbruchUndLeerzeichen', start: '\n  ', end: '', crlf: false },
  { name: 'endeTabulator', start: '', end: '\t', crlf: false },
  { name: 'endeVertikalerTabulator', start: '', end: '\u000B', crlf: false },
  { name: 'endeSeitenvorschub', start: '', end: '\u000C', crlf: false },
  {
    name: 'endeGeschuetztesLeerzeichen',
    start: '',
    end: '\u00A0',
    crlf: false,
  },
  {
    name: 'endeIdeografischesLeerzeichen',
    start: '',
    end: '\u3000',
    crlf: false,
  },
  { name: 'zeilenendenCrlf', start: '', end: '', crlf: true },
]);

/**
 * The text of one case.
 *
 * @param day - The day of the run.
 * @param wikiCase - The case.
 * @param index - Its number, which makes the text differ from the others.
 * @returns The text as the probe sends it.
 */
export function caseText(
  day: string,
  wikiCase: WikiCase,
  index: number,
): string {
  return `${wikiCase.start}${coreFormText(day, `Fall ${String(index)}`, wikiCase.crlf ? '\r\n' : '\n')}${wikiCase.end}`;
}

// The characters PHP removes with trim by default; NUL the server of
// Ecclium never sends.
const phpSpaces = ' \t\n\r\u0000\u000B';

/**
 * Removes at both ends what `trim` of PHP removes by default.
 *
 * @param text - A text.
 * @returns The text without those characters at its ends.
 * @example
 * ```ts
 * trimLikePhp('\n Text \u00A0\n'); // 'Text \u00A0'
 * ```
 */
export function trimLikePhp(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && phpSpaces.includes(text.charAt(start))) start += 1;
  while (end > start && phpSpaces.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * Names the classes of the characters of a text, each once, in the order
 * they first appear.
 *
 * @param text - Characters removed at one end.
 * @returns Fixed words.
 */
export function classesOf(text: string): readonly string[] {
  const names: string[] = [];
  for (const character of text) {
    const name =
      spaceClasses.find(([sign]) => sign === character)?.[1] ?? otherCharacter;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// Whether a text holds only white space, as JavaScript reads it.
const onlySpace = (text: string): boolean => /^\s*$/u.test(text);

// The stored text as the sent one without white space at its ends, if
// that is what it is: the removed start and end, else undefined.
function trimmedEnds(
  sent: string,
  stored: string,
): { readonly start: string; readonly end: string } | undefined {
  // An empty text is found at every index, also past the end.
  if (stored === '') {
    return onlySpace(sent) ? { start: sent, end: '' } : undefined;
  }
  let index = sent.indexOf(stored);
  while (index !== -1) {
    const start = sent.slice(0, index);
    const end = sent.slice(index + stored.length);
    if (onlySpace(start) && onlySpace(end)) return { start, end };
    index = sent.indexOf(stored, index + 1);
  }
  return undefined;
}

const lineEndsOf = (text: string): string => {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  if (crlf === 0 && lf === 0) return 'keine';
  if (crlf === 0) return 'LF';
  return lf === 0 ? 'CRLF' : 'gemischt';
};

/**
 * Compares the text a probe sent with the text it read back, in fixed
 * words: the same, the same without white space at its ends (with the
 * classes removed at each end), the same with line ends turned into LF as
 * well, or different (with the class of the difference in length and the
 * line ends read back).
 *
 * @param sent - The text sent.
 * @param stored - The text read back, undefined if the read failed.
 * @returns The comparison.
 * @example
 * ```ts
 * compareStored('Text\n', 'Text');
 * // { zurueckgelesen: 'ohne Leerraum an den Enden', entferntAnfang: [], entferntEnde: ['Zeilenumbruch'] }
 * ```
 */
export function compareStored(
  sent: string,
  stored: string | null | undefined,
): Record<string, Json> {
  if (stored === undefined) return { zurueckgelesen: 'unbekannt' };
  const text = stored ?? '';
  if (text === sent) {
    return {
      zurueckgelesen: 'wie gesendet',
      entferntAnfang: [],
      entferntEnde: [],
    };
  }
  const trimmed = trimmedEnds(sent, text);
  if (trimmed !== undefined) {
    return {
      zurueckgelesen: 'ohne Leerraum an den Enden',
      entferntAnfang: classesOf(trimmed.start),
      entferntEnde: classesOf(trimmed.end),
    };
  }
  const lf = trimmedEnds(sent.replaceAll('\r\n', '\n'), text);
  if (lf !== undefined) {
    return {
      zurueckgelesen: 'Zeilenenden zu LF, ohne Leerraum an den Enden',
      entferntAnfang: classesOf(lf.start),
      entferntEnde: classesOf(lf.end),
    };
  }
  return {
    zurueckgelesen: 'anders',
    laengeDifferenz: countClass(Math.abs(text.length - sent.length)),
    zeilenenden: lineEndsOf(text),
  };
}

/** A text sent and the text read back, for {@link ruleOf}. */
export interface Observation {
  readonly sent: string;
  readonly stored: string | undefined;
}

/**
 * Tells which rule explains every text read back: `trim` of PHP, `trim()`
 * of JavaScript, which removes every white space of Unicode, or neither.
 *
 * @param observations - The texts sent and read back.
 * @returns A fixed word.
 */
export function ruleOf(observations: readonly Observation[]): string {
  if (
    observations.length === 0 ||
    observations.some((o) => o.stored === undefined)
  ) {
    return 'unbekannt';
  }
  const explains = (rule: (text: string) => string): boolean =>
    observations.every((o) => o.stored === rule(o.sent));
  if (explains(trimLikePhp)) return 'wie trim in PHP';
  if (explains((text) => text.trim())) return 'wie trim in JavaScript';
  return 'keine der beiden';
}

/**
 * Whether a value of ChurchTools holds anything: text that is not blank, a
 * number, `true`, or a list or object that holds such a value at any depth.
 * The same rule as the server of Ecclium, read without recursion.
 *
 * @param value - A value of an answer.
 * @returns Whether it holds a value.
 */
export function holdsValue(value: unknown): boolean {
  const open: unknown[] = [value];
  while (open.length > 0) {
    const next = open.pop();
    if (typeof next === 'string') {
      if (next.trim() !== '') return true;
    } else if (typeof next === 'number' || next === true) {
      return true;
    } else if (typeof next === 'object' && next !== null) {
      for (const inner of Object.values(next as Record<string, unknown>)) {
        open.push(inner);
      }
    }
  }
  return false;
}

// A list or an object that holds a value: the form in which the server
// counts a part as linked.
const isLink = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && holdsValue(value);

/**
 * The keys of `data` in a read of one appointment that the server of
 * Ecclium knows: those the OpenAPI document of 3.138 describes.
 */
export const knownStateKeys: readonly string[] = Object.freeze([
  'appointment',
  'additionalInfos',
  'calculatedDates',
]);

/**
 * The keys of the appointment in a read of one appointment that the server
 * of Ecclium knows: those the OpenAPI document of 3.138 describes.
 */
export const knownAppointmentKeys: readonly string[] = Object.freeze([
  'additionals',
  'additions',
  'address',
  'allDay',
  'calendar',
  'caption',
  'description',
  'endDate',
  'exceptions',
  'id',
  'image',
  'information',
  'isInternal',
  'link',
  'meta',
  'note',
  'onBehalfOfPid',
  'repeatFrequency',
  'repeatId',
  'repeatOption',
  'repeatUntil',
  'signup',
  'startDate',
  'subtitle',
  'title',
  'version',
]);

/** A key of a read of an appointment that the server does not know. */
export interface UnknownKey {
  readonly place: (typeof places)[keyof typeof places];
  readonly key: string;
  readonly value: unknown;
}

const datesOf = (data: JsonObject): readonly unknown[] => {
  const dates = data['calculatedDates'];
  if (Array.isArray(dates)) return dates;
  return isObject(dates) ? Object.values(dates) : [];
};

const isDateKey = (key: string): boolean =>
  key === 'startDate' || key === 'endDate';

/**
 * Finds the keys of a read of one appointment that the server of Ecclium
 * does not know: beside the appointment, in it, and in a calculated date
 * beside its start and end. Each key once per place.
 *
 * @param data - `data` of the answer.
 * @returns The keys with their values, in the order of the answer.
 */
export function unknownKeys(data: JsonObject): readonly UnknownKey[] {
  const found: UnknownKey[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!knownStateKeys.includes(key)) {
      found.push({ place: places.data, key, value });
    }
  }
  const appointment = data['appointment'];
  if (isObject(appointment)) {
    for (const [key, value] of Object.entries(appointment)) {
      if (!knownAppointmentKeys.includes(key)) {
        found.push({ place: places.appointment, key, value });
      }
    }
  }
  const seen = new Set<string>();
  for (const date of datesOf(data)) {
    if (!isObject(date)) continue;
    for (const [key, value] of Object.entries(date)) {
      if (!isDateKey(key) && !seen.has(key)) {
        seen.add(key);
        found.push({ place: places.date, key, value });
      }
    }
  }
  return found;
}

/**
 * Whether a key and its value are the legacy field mappings the server of
 * Ecclium does not count as linked (F52): `@deprecated` with an object in
 * which every key names a field the document describes for the same object
 * and every value is a text. The same rule as the server.
 *
 * @param key - The key the server does not know.
 * @param value - Its value.
 * @param known - The keys the document describes at that place.
 * @returns Whether the server lets it pass.
 */
export function isLegacyMappings(
  key: string,
  value: unknown,
  known: readonly string[],
): boolean {
  return (
    key === '@deprecated' &&
    isObject(value) &&
    Object.entries(value).every(
      ([old, inner]) => known.includes(old) && typeof inner === 'string',
    )
  );
}

// The keys the server knows at a place of an unknown key, for the legacy
// field mappings; a date has none of its own beside its start and end.
const knownAt = (place: UnknownKey['place']): readonly string[] =>
  place === places.data
    ? knownStateKeys
    : place === places.appointment
      ? knownAppointmentKeys
      : [];

/**
 * Applies the rules by which the server of Ecclium counts an appointment
 * as linked, so that it neither changes nor deletes it: a value in the
 * additional infos, a link in a date beside its start and end, and a link
 * under a key it does not know beside or in the appointment, but for the
 * legacy field mappings there. Also names
 * the other parts it would not change: a series, an address, a link, an
 * image, a sign-up and an appointment on behalf of a person.
 *
 * @param data - `data` of the answer.
 * @returns Each rule as «ja» or «nein», and the other parts by name.
 */
export function serverRules(data: JsonObject): Record<string, Json> {
  const appointment = isObject(data['appointment']) ? data['appointment'] : {};
  const unknown = unknownKeys(data);
  const linkIn = (place: UnknownKey['place']): boolean =>
    unknown.some(
      (entry) =>
        entry.place === place &&
        isLink(entry.value) &&
        !isLegacyMappings(entry.key, entry.value, knownAt(place)),
    );
  const yes = (value: boolean): string => (value ? 'ja' : 'nein');
  const listed = (key: string): number => {
    const value = appointment[key];
    return Array.isArray(value) ? value.length : 0;
  };
  const parts: string[] = [];
  if (
    (typeof appointment['repeatId'] === 'number' &&
      appointment['repeatId'] !== 0) ||
    listed('additionals') > 0 ||
    listed('exceptions') > 0
  ) {
    parts.push('Serie');
  }
  if (holdsValue(appointment['address'])) parts.push('Adresse');
  if (holdsValue(appointment['link'])) parts.push('Link');
  if (holdsValue(appointment['image'])) parts.push('Bild');
  if (holdsValue(appointment['signup'])) parts.push('Anmeldung');
  if (typeof appointment['onBehalfOfPid'] === 'number')
    parts.push('im Auftrag');
  const dated = datesOf(data).some(
    (date) =>
      isObject(date) &&
      Object.entries(date).some(
        ([key, value]) => !isDateKey(key) && isLink(value),
      ),
  );
  const rules = {
    zusatzinfos: isLink(data['additionalInfos']),
    datumMitVerweis: dated,
    unbekanntNebenTermin: linkIn(places.data),
    unbekanntImTermin: linkIn(places.appointment),
  };
  return {
    zusatzinfos: yes(rules.zusatzinfos),
    datumMitVerweis: yes(rules.datumMitVerweis),
    unbekanntNebenTermin: yes(rules.unbekanntNebenTermin),
    unbekanntImTermin: yes(rules.unbekanntImTermin),
    weitereTeile: parts,
    verknuepft: yes(Object.values(rules).some(Boolean) || parts.length > 0),
  };
}

const typeOf = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'Liste';
  if (typeof value === 'object') return 'Objekt';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return 'Zahl';
  if (typeof value === 'boolean') return 'Wahrheitswert';
  return 'null';
};

/** What a text of an unknown key is compared with. */
export interface TextContext {
  /** The origin of the instance. */
  readonly origin: string;
  /** The appointment as read, for the comparison with its fields. */
  readonly appointment: JsonObject;
  /** The ID of the appointment. */
  readonly id: number;
}

/**
 * Describes a text of a key the server does not know, never the text: its
 * form (empty, an address on this instance, another address, a path, or
 * text), the documented field of the appointment it equals, if any, and
 * whether it names the ID of the appointment as a whole number.
 *
 * @param text - The text.
 * @param context - Origin, appointment and ID.
 * @returns Fixed words and documented field names.
 */
export function textForm(
  text: string,
  context: TextContext,
): Record<string, Json> {
  if (text === '') return { form: 'leer' };
  let form = 'Text';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      form =
        url.origin === context.origin ? 'Adresse dieser Instanz' : 'Adresse';
    }
  } catch {
    if (text.startsWith('/')) form = 'Pfad';
  }
  const same = knownAppointmentKeys.find(
    (key) =>
      typeof context.appointment[key] === 'string' &&
      context.appointment[key] === text,
  );
  const id = String(context.id);
  const numbers: readonly string[] = text.match(/\d+/g) ?? [];
  const namesId = numbers.includes(id);
  return {
    form,
    gleichWie: same ?? 'keine',
    nenntKennung: namesId ? 'ja' : 'nein',
  };
}

/** A read of one appointment, kept until the report is written. */
interface AppointmentRead {
  readonly response: ProbeResponse;
  readonly data: JsonObject | undefined;
}

/** Everything the steps of the probe share. */
interface Run {
  readonly client: Client;
  readonly reader: Client;
  readonly writer: WriteClient;
  readonly guard: Guard;
  readonly schemas: Schemas;
  readonly document: OpenApiDocument;
  readonly origin: string;
  readonly category: number;
  readonly area: CalendarArea;
  readonly pages: WriteStateFile;
  readonly dates: CalendarStateFile;
  readonly wait: (milliseconds: number) => Promise<void>;
  /** The day of the run, the day the marking names. */
  readonly day: string;
  /** The day and times of the appointment. */
  readonly times: ReturnType<typeof readbackTimes>;
  /** What the run created and has not deleted yet. */
  readonly open: { page: string | undefined; appointment: number | undefined };
}

const succeeded = (response: ProbeResponse): boolean =>
  response.status >= 200 && response.status < 300;

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

function describeWrite(
  run: Run,
  response: ProbeResponse,
  operation: WriteOperation,
): Json {
  const { method, template } = writeTemplate(operation);
  return describeResponse(response, {
    guard: run.guard,
    schemas: run.schemas,
    operation: findOperation(run.document, method, template),
  });
}

async function send(
  run: Run,
  operation: WriteOperation,
  parameters: readonly (string | number)[],
  body?: { readonly [key: string]: Json },
): Promise<ProbeResponse> {
  await run.wait(pauseBeforeWrite);
  const response = await run.writer.send({
    operation,
    parameters,
    ...(body === undefined ? {} : { body }),
  });
  run.guard.allowFixed(response.status);
  return response;
}

async function readBack(run: Run, guid: string): Promise<PageView> {
  const view = await readPage(run.client, run.category, guid);
  run.guard.allowFixed(view.status);
  return view;
}

const versionStep = (
  before: number | undefined,
  after: number | undefined,
): string => {
  if (before === undefined || after === undefined) return 'unbekannt';
  if (after === before + 1) return 'neu';
  return after === before ? 'gleich' : 'andere';
};

async function wikiPart(run: Run): Promise<Json> {
  const title = `${pageTitlePrefix}-${run.pages.run}-form`;
  const first = caseText(run.day, createCase, 0);
  const created = await send(run, 'wikiPageCreate', [run.category], {
    title,
    text: first,
    isMarkdown: true,
  });
  const data = dataOf(created);
  const guid = isObject(data) ? data['guid'] : undefined;
  if (typeof guid === 'string' && guidPattern.test(guid)) {
    run.pages.addPage(guid, 'form');
    run.open.page = guid;
  } else if (succeeded(created)) {
    // A page without a GUID nobody could remove through the API.
    throw new SpikeError('ANTWORT_UNGUELTIG');
  }
  if (run.open.page === undefined) {
    return {
      anlegen: {
        status: created.status,
        antwort: describeWrite(run, created, 'wikiPageCreate'),
      },
      faelle: 'nicht ausgeführt',
    };
  }
  const page = run.open.page;
  let view = await readBack(run, page);
  const observations: Observation[] = [
    {
      sent: first,
      stored: view.status === 200 ? (view.text ?? '') : undefined,
    },
  ];
  const anlegen = {
    status: created.status,
    version:
      view.version === undefined ? 'unbekannt' : countClass(view.version),
    ...compareStored(first, view.status === 200 ? view.text : undefined),
  };
  const faelle: Record<string, Json> = {};
  for (const [index, wikiCase] of wikiCases.entries()) {
    const text = caseText(run.day, wikiCase, index + 1);
    const response = await send(run, 'wikiPageUpdate', [run.category, page], {
      text,
    });
    const after = await readBack(run, page);
    const stored = after.status === 200 ? (after.text ?? '') : undefined;
    if (!wikiCase.crlf) observations.push({ sent: text, stored });
    faelle[wikiCase.name] = {
      status: response.status,
      version: versionStep(view.version, after.version),
      ...compareStored(text, stored),
      ...(succeeded(response)
        ? {}
        : { antwort: describeWrite(run, response, 'wikiPageUpdate') }),
    };
    view = after;
  }
  const removed = await send(run, 'wikiPageDelete', [run.category, page]);
  const gone = await readBack(run, page);
  if (succeeded(removed) || gone.status === 404) run.open.page = undefined;
  return {
    anlegen,
    faelle,
    regel: ruleOf(observations),
    loeschen: { status: removed.status, danachLesen: gone.status },
  };
}

async function readAppointment(
  run: Run,
  id: number,
  enriched: boolean,
): Promise<AppointmentRead> {
  const response = await run.reader.get({
    path: pathFor(
      calendarOperations.calendarAppointment.template,
      run.area.calendar,
      id,
    ),
    ...(enriched
      ? {
          query: appointmentIncludes.map(
            (value) => ['include[]', value] as const,
          ),
        }
      : {}),
  });
  run.guard.allowFixed(response.status);
  const data = dataOf(response);
  return {
    response,
    data: response.status === 200 && isObject(data) ? data : undefined,
  };
}

/** What the appointment part keeps until the report is written. */
interface AppointmentRecord {
  readonly created: ProbeResponse;
  readonly id: number | undefined;
  readonly title: string;
  readonly changedTitle: string;
  readonly enriched?: AppointmentRead;
  readonly plain?: AppointmentRead;
  readonly changed?: ProbeResponse;
  readonly after?: AppointmentRead;
  readonly removed?: ProbeResponse;
  readonly gone?: ProbeResponse;
}

async function appointmentPart(run: Run): Promise<AppointmentRecord> {
  const { start, end } = run.times;
  const title = `${pageTitlePrefix}-${run.dates.run}-form`;
  const changedTitle = `${title}-neu`;
  // Exactly the fields the server of Ecclium sends for a new appointment.
  const created = await send(run, 'appointmentCreate', [run.area.calendar], {
    title,
    description: 'Synthetischer Termin der Probe für das Zurücklesen',
    startDate: start,
    endDate: end,
    isInternal: false,
    repeatId: 0,
  });
  const data = dataOf(created);
  // The answer to a create holds the stored object at the top of `data`.
  const id = isObject(data) ? data['id'] : undefined;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    run.dates.created('termin', id);
    run.open.appointment = id;
  } else if (succeeded(created)) {
    // Its cleanup finds it by its title.
    throw new SpikeError('ANTWORT_UNGUELTIG');
  }
  if (run.open.appointment === undefined) {
    return { created, id: undefined, title, changedTitle };
  }
  const target = run.open.appointment;
  const enriched = await readAppointment(run, target, true);
  const plain = await readAppointment(run, target, false);
  const stored = enriched.data?.['appointment'];
  const read = isObject(stored) ? stored : {};
  const subtitle = read['subtitle'];
  // Exactly the fields the server of Ecclium sends for a change: a field
  // without a value it leaves out (F41).
  const changed = await send(
    run,
    'appointmentUpdate',
    [run.area.calendar, target],
    {
      title: changedTitle,
      ...(typeof subtitle === 'string' && subtitle.trim() !== ''
        ? { subtitle }
        : {}),
      description: 'Geänderte Beschreibung der Probe für das Zurücklesen',
      startDate: start,
      endDate: end,
      isInternal: read['isInternal'] === true,
      repeatId: 0,
    },
  );
  const after = await readAppointment(run, target, true);
  const removed = await send(run, 'appointmentDelete', [
    run.area.calendar,
    target,
  ]);
  const gone = await run.reader.get({
    path: pathFor(
      calendarOperations.calendarAppointment.template,
      run.area.calendar,
      target,
    ),
  });
  run.guard.allowFixed(gone.status);
  if (succeeded(removed) || gone.status === 404) {
    run.dates.deleted('termin', target);
    run.open.appointment = undefined;
  }
  return {
    created,
    id: target,
    title,
    changedTitle,
    enriched,
    plain,
    changed,
    after,
    removed,
    gone,
  };
}

/**
 * Deletes what the run left behind. Errors here end nothing: whatever
 * stays is still in the write state files for 07 and 11.
 *
 * @param run - The run.
 * @returns For page and appointment: deleted, left, or none.
 */
async function cleanUp(run: Run): Promise<Json> {
  const result: Record<string, string> = { seite: 'keine', termin: 'keine' };
  const page = run.open.page;
  if (page !== undefined) {
    try {
      const response = await send(run, 'wikiPageDelete', [run.category, page]);
      if (succeeded(response) || response.status === 404)
        run.open.page = undefined;
    } catch {
      // Counted as left below.
    }
    result['seite'] = run.open.page === undefined ? 'gelöscht' : 'übrig';
  }
  const appointment = run.open.appointment;
  if (appointment !== undefined) {
    try {
      const response = await send(run, 'appointmentDelete', [
        run.area.calendar,
        appointment,
      ]);
      if (succeeded(response) || response.status === 404) {
        run.dates.deleted('termin', appointment);
        run.open.appointment = undefined;
      }
    } catch {
      // Counted as left below.
    }
    result['termin'] =
      run.open.appointment === undefined ? 'gelöscht' : 'übrig';
  }
  return result;
}

/**
 * Writes the report of the appointment once every request is done, so
 * that each name is checked against the whole block list.
 *
 * @param run - The run.
 * @param record - What the appointment part kept.
 * @returns The report.
 */
function appointmentReport(run: Run, record: AppointmentRecord): Json {
  const nameOf = (key: string): string => {
    if (identifierKey.test(key) && run.guard.passesBlockList(key)) {
      run.guard.allowChecked(key);
      return key;
    }
    return 'zurückgehalten';
  };
  const anlegen: Record<string, Json> = { status: record.created.status };
  if (!succeeded(record.created)) {
    anlegen['antwort'] = describeWrite(
      run,
      record.created,
      'appointmentCreate',
    );
  }
  if (record.id === undefined || record.enriched === undefined) {
    return { anlegen, angelegt: 'nein' };
  }
  const id = record.id;
  const fieldsOf = (value: unknown, appointment: JsonObject): Json[] =>
    isObject(value)
      ? Object.entries(value).map(([key, inner]) => ({
          name: nameOf(key),
          typ: typeOf(inner),
          ...(typeof inner === 'string'
            ? textForm(inner, { origin: run.origin, appointment, id })
            : {}),
        }))
      : [];
  const describeUnknown = (read: AppointmentRead | undefined): Json => {
    if (read?.data === undefined) return 'unbekannt';
    const stored = read.data['appointment'];
    const appointment = isObject(stored) ? stored : {};
    return unknownKeys(read.data).map((entry) => ({
      ort: entry.place,
      name: nameOf(entry.key),
      typ: typeOf(entry.value),
      verweis: yesNo(isLink(entry.value)),
      alteFeldnamen: yesNo(
        entry.place !== places.date &&
          isLegacyMappings(entry.key, entry.value, knownAt(entry.place)),
      ),
      felder: fieldsOf(entry.value, appointment),
    }));
  };
  const operation = findOperation(
    run.document,
    calendarOperations.calendarAppointment.method,
    calendarOperations.calendarAppointment.template,
  );
  const lesen: Record<string, Json> = {
    status: record.enriched.response.status,
    struktur: describeResponse(record.enriched.response, {
      guard: run.guard,
      schemas: run.schemas,
      operation,
    }),
    unbekannt: describeUnknown(record.enriched),
    ...(record.enriched.data === undefined
      ? {}
      : { regelnDesServers: serverRules(record.enriched.data) }),
  };
  const lesenOhneInclude = {
    status: record.plain?.response.status ?? 'unbekannt',
    unbekannt: describeUnknown(record.plain),
  };
  const aendern: Record<string, Json> = {
    status: record.changed?.status ?? 'unbekannt',
  };
  if (record.changed !== undefined && !succeeded(record.changed)) {
    aendern['antwort'] = describeWrite(
      run,
      record.changed,
      'appointmentUpdate',
    );
  }
  const before = record.enriched.data;
  const after = record.after?.data;
  if (before !== undefined && after !== undefined) {
    const versionOf = (data: JsonObject): number | undefined => {
      const stored = data['appointment'];
      const version = isObject(stored) ? stored['version'] : undefined;
      return typeof version === 'number' ? version : undefined;
    };
    const from = versionOf(before);
    const to = versionOf(after);
    const steps =
      from === undefined || to === undefined ? undefined : to - from;
    aendern['versionDifferenz'] =
      steps === undefined
        ? 'unbekannt'
        : steps <= 0
          ? 'keine'
          : steps === 1
            ? 'eins'
            : steps === 2
              ? 'zwei'
              : 'mehr';
    const later = unknownKeys(after);
    const compared: Json[] = unknownKeys(before).map((entry) => {
      const match = later.find(
        (other) => other.place === entry.place && other.key === entry.key,
      );
      const result =
        match === undefined
          ? 'fehlt'
          : JSON.stringify(match.value) === JSON.stringify(entry.value)
            ? 'gleich'
            : holdsValue(match.value)
              ? 'anders'
              : 'leer';
      const felder =
        match !== undefined && result === 'anders' && isObject(entry.value)
          ? Object.entries(entry.value).map(([key, inner]) => {
              const now = isObject(match.value) ? match.value[key] : undefined;
              return {
                name: nameOf(key),
                ergebnis:
                  now === undefined
                    ? 'fehlt'
                    : JSON.stringify(now) === JSON.stringify(inner)
                      ? 'gleich'
                      : 'anders',
                folgtTitel: yesNo(
                  typeof now === 'string' &&
                    typeof inner === 'string' &&
                    inner.includes(record.title) &&
                    now.includes(record.changedTitle),
                ),
              };
            })
          : [];
      return {
        ort: entry.place,
        name: nameOf(entry.key),
        ergebnis: result,
        felder,
      };
    });
    const added: Json[] = later
      .filter(
        (entry) =>
          !unknownKeys(before).some(
            (other) => other.place === entry.place && other.key === entry.key,
          ),
      )
      .map((entry) => ({
        ort: entry.place,
        name: nameOf(entry.key),
        ergebnis: 'neu',
      }));
    aendern['nachAenderung'] = [...compared, ...added];
    aendern['regelnDesServers'] = serverRules(after);
  }
  return {
    anlegen,
    angelegt: 'ja',
    lesen,
    lesenOhneInclude,
    aendern,
    loeschen: {
      status: record.removed?.status ?? 'unbekannt',
      danachLesen: record.gone?.status ?? 'unbekannt',
    },
  };
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '13-write-readback',
  state: 'read',
  account: 'write',
  async run({ client, guard, state, write, origin, env, wait }): Promise<Json> {
    // The documented keys are words of the probe: a text of a key the
    // server does not know is compared with the field it equals.
    guard.allowFixed(
      ...words,
      ...countClasses,
      ...knownAppointmentKeys,
      ...wikiCases.map((wikiCase) => wikiCase.name),
    );
    if (state === undefined || write === undefined) {
      throw new Error('INTERN');
    }
    const area = write.settings.calendarArea;
    if (area === undefined) {
      throw new SpikeError('KONFIGURATION', 'zuruecklesenOhneBereich');
    }
    const calendarStatePath =
      env['ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE'] ?? '';
    if (calendarStatePath === '') {
      throw new SpikeError('KONFIGURATION', 'zuruecklesenKalenderStateFehlt');
    }
    if (calendarStatePath === write.settings.writeStatePath) {
      throw new SpikeError('KONFIGURATION', 'zuruecklesenStateGleich');
    }
    checkNewWriteState(write.settings.writeStatePath);
    checkNewWriteState(calendarStatePath);
    const document = state.specification;
    for (const name of ['wikiPage', 'wikiPageVersions'] as const) {
      const { method, template } = operations[name];
      if (findOperation(document, method, template) === undefined) {
        throw new SpikeError('KONFIGURATION', 'leseOperationFehlt');
      }
    }
    const now = new Date();
    const times = readbackTimes(now);
    const { day } = times;
    const { writer, reader, result } = await passGate(
      { client, state },
      write.access,
      write.settings,
      {
        writes: [
          'wikiPageCreate',
          'wikiPageUpdate',
          'wikiPageDelete',
          'appointmentCreate',
          'appointmentUpdate',
          'appointmentDelete',
        ],
        ownPages: new Set(),
        calendar: {
          ownAppointments: new Set(),
          ownBookings: new Set(),
          from: day,
          to: day,
        },
        summary,
      },
    );
    if (reader === undefined) {
      throw new SpikeError('INTERN');
    }
    const pages = WriteStateFile.create(
      write.settings.writeStatePath,
      origin,
      result.writeCategory,
    );
    let dates: CalendarStateFile;
    try {
      dates = CalendarStateFile.create(calendarStatePath, origin, area, day);
    } catch (error) {
      pages.close();
      throw error;
    }
    const run: Run = {
      client,
      reader,
      writer,
      guard,
      schemas: new Schemas(document),
      document,
      origin,
      category: result.writeCategory,
      area,
      pages,
      dates,
      wait,
      day: now.toISOString().slice(0, 10),
      times,
      open: { page: undefined, appointment: undefined },
    };
    try {
      let completed = false;
      try {
        const wiki = await wikiPart(run);
        const record = await appointmentPart(run);
        completed = true;
        const aufraeumen = await cleanUp(run);
        let rechteUnveraendert = 'unbekannt';
        try {
          const within = await rightsStillWithin(
            client,
            write.settings,
            result.identification,
          );
          rechteUnveraendert =
            within === undefined ? 'unbekannt' : yesNo(within);
        } catch {
          // Only a read after every write: the report still counts.
        }
        return {
          probe: '13-write-readback',
          wiki,
          termin: appointmentReport(run, record),
          aufraeumen,
          rechteUnveraendert,
        };
      } finally {
        if (!completed) {
          await cleanUp(run);
        }
      }
    } catch (error) {
      throw error instanceof SpikeError
        ? new SpikeError(error.code, 'zuruecklesenAbgebrochen')
        : new SpikeError('INTERN', 'zuruecklesenAbgebrochen');
    } finally {
      pages.close();
      dates.close();
    }
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
