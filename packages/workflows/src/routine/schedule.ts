/**
 * The check of the schedule of a routine (ADR 0034).
 *
 * Where it stands in a run: when the routines are loaded, long before a
 * run is due. It only checks the form; when a routine is due and which
 * period it serves is reckoned later from the same text, by one function
 * for the daemon and for a single run.
 *
 * Why it is narrower than cron: implementations of cron read some forms
 * differently, so a routine may use only the forms they share. A
 * schedule has five fields, minute, hour, day of the month, month and day
 * of the week, one space apart, without seconds or years. A field holds
 * `*`, a value, a range `a-b`, a step `*\/n` or `a-b/n`, or a list of
 * these with commas. Months and days of the week may also be named with
 * their English abbreviations, such as `JAN` or `MON`, in any case. A
 * day of the week is 0 (Sunday) to 6, so that no implementation reads
 * 7 another way. The day of the month and the day of the week must not
 * both be restricted, because cron joins the two with «or» and some of its
 * copies with «and».
 *
 * @packageDocumentation
 */

/** The fields of a schedule, in their order, frozen. */
export const scheduleFieldNames = Object.freeze([
  'minute',
  'hour',
  'dayOfMonth',
  'month',
  'dayOfWeek',
] as const);

/** A field of a schedule. */
export type ScheduleFieldName = (typeof scheduleFieldNames)[number];

/** Why a schedule is refused. */
export type ScheduleProblem =
  | {
      /** The text is no five fields, or a field holds a form not allowed. */
      readonly reason: 'invalid';
      /** The field, when the problem lies in one. */
      readonly field?: ScheduleFieldName;
    }
  | {
      /** Day of the month and day of the week are both restricted. */
      readonly reason: 'days';
    };

/** The result of the check of a schedule. */
export type ScheduleCheck =
  { readonly ok: true } | ({ readonly ok: false } & ScheduleProblem);

interface FieldRange {
  readonly min: number;
  readonly max: number;
  /** Names for the values from `min` on, in upper case. */
  readonly names?: readonly string[];
}

const ranges: Readonly<Record<ScheduleFieldName, FieldRange>> = Object.freeze({
  minute: Object.freeze({ min: 0, max: 59 }),
  hour: Object.freeze({ min: 0, max: 23 }),
  dayOfMonth: Object.freeze({ min: 1, max: 31 }),
  month: Object.freeze({
    min: 1,
    max: 12,
    names: Object.freeze([
      'JAN',
      'FEB',
      'MAR',
      'APR',
      'MAY',
      'JUN',
      'JUL',
      'AUG',
      'SEP',
      'OCT',
      'NOV',
      'DEC',
    ]),
  }),
  dayOfWeek: Object.freeze({
    min: 0,
    max: 6,
    names: Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']),
  }),
});

// One or two digits, or three letters.
const valuePattern = /^(?:\d{1,2}|[A-Za-z]{3})$/;

// The number of a value, or undefined when it is none of this field.
const valueOf = (text: string, range: FieldRange): number | undefined => {
  if (!valuePattern.test(text)) return undefined;
  const value = /^\d/.test(text)
    ? Number(text)
    : range.names === undefined
      ? -1
      : range.names.indexOf(text.toUpperCase()) + range.min;
  return value >= range.min && value <= range.max ? value : undefined;
};

// Whether a step after a slash is a whole number from 1 to the size of
// the field.
const stepIsValid = (text: string, range: FieldRange): boolean =>
  /^\d{1,2}$/.test(text) &&
  Number(text) >= 1 &&
  Number(text) <= range.max - range.min + 1;

// Whether one part of a list is allowed: `*`, `*/n`, a value, `a-b` or
// `a-b/n`. A value with a step, such as `5/15`, is not, because cron
// copies read it differently.
const partIsValid = (part: string, range: FieldRange): boolean => {
  const [head = '', step, rest] = part.split('/');
  if (rest !== undefined) return false;
  if (step !== undefined && !stepIsValid(step, range)) return false;
  if (head === '*') return true;
  const [from = '', to, beyond] = head.split('-');
  if (beyond !== undefined) return false;
  const start = valueOf(from, range);
  if (start === undefined) return false;
  if (to === undefined) return step === undefined;
  const end = valueOf(to, range);
  return end !== undefined && start <= end;
};

// A list has at most 60 parts. A routine cannot reach that within the
// limit of its schedule; the bound holds for any other caller.
const fieldIsValid = (text: string, range: FieldRange): boolean => {
  const parts = text.split(',');
  return parts.length <= 60 && parts.every((part) => partIsValid(part, range));
};

const refuse = (problem: ScheduleProblem): ScheduleCheck =>
  Object.freeze({ __proto__: null, ok: false, ...problem });

/**
 * Checks the form of the schedule of a routine.
 *
 * @param schedule - The schedule as the routine states it, such as
 *   `0 6 * * MON`.
 * @returns Whether the form is allowed, or why not and in which field.
 *   It never throws for a text.
 * @throws {TypeError} When the schedule is not a string.
 * @example
 * ```ts
 * checkSchedule('0 6 * * MON'); // { ok: true }
 * checkSchedule('0 6 1 * MON'); // { ok: false, reason: 'days' }
 * ```
 */
export function checkSchedule(schedule: string): ScheduleCheck {
  if (typeof schedule !== 'string') {
    throw new TypeError('The schedule must be a string.');
  }
  const fields = schedule.split(' ');
  if (fields.length !== scheduleFieldNames.length) {
    return refuse({ reason: 'invalid' });
  }
  for (const [index, name] of scheduleFieldNames.entries()) {
    if (!fieldIsValid(fields[index] ?? '', ranges[name])) {
      return refuse({ reason: 'invalid', field: name });
    }
  }
  if (fields[2] !== '*' && fields[4] !== '*') return refuse({ reason: 'days' });
  return Object.freeze({ __proto__: null, ok: true });
}
