/**
 * The synthetic data set of the seed (ADR 0061).
 *
 * Every name and title starts with the marker «Seedprobe», the last name of
 * every person is the marker. The seed finds its objects again by these
 * exact names and resets only objects that carry them. The marker differs
 * from «Spikeprobe» and «Synthetisch», which the objects made by hand for
 * the probes carry, so the seed never touches those.
 *
 * Nothing here comes from a real congregation: names follow the
 * placeholder rules («Person A»), persons have no contact data, and the
 * texts of the wiki are written for this file.
 *
 * @packageDocumentation
 */
import { seedWikiCategoryName } from '../../spike/lib/seed-gate.mts';
import { at, anchorSaturday } from './dates.mts';

/** The marker every object of the seed carries. */
export const marker = 'Seedprobe';

/** The structure the seed creates if it is missing and never deletes. */
export const structure = {
  groupType: {
    label: 'gy',
    name: 'Seedprobe Gruppen',
    namePlural: 'Seedprobe Gruppen',
    shorty: 'SPG',
  },
  calendar: { label: 'c', name: 'Seedprobe Kalender' },
  resourceType: {
    label: 'rt',
    name: 'Seedprobe Räume',
    namePlural: 'Seedprobe Räume',
  },
  resource: { label: 'r', name: 'Seedprobe Saal' },
  serviceGroup: { label: 'sg', name: 'Seedprobe Dienste' },
  songCategory: { label: 'sc', name: 'Seedprobe Lieder' },
  wikiCategory: { label: 'w', name: seedWikiCategoryName },
} as const;

/** A service of the seed. */
export interface ServiceSpec {
  readonly label: 's1' | 's2';
  readonly name: string;
  /** Whether the service hides the names of the persons in it. */
  readonly hidePersonName: boolean;
}

/** The two services: one shows names, one hides them. */
export const services: readonly ServiceSpec[] = [
  { label: 's1', name: 'Seedprobe Technik', hidePersonName: false },
  { label: 's2', name: 'Seedprobe Seelsorge', hidePersonName: true },
];

/** The label of a person of the seed. */
export type PersonLabel = 'pA' | 'pB' | 'pC' | 'pD' | 'pE' | 'pF';

/** A person of the seed, by first and last name. */
export interface PersonSpec {
  readonly label: PersonLabel;
  readonly firstName: string;
  readonly lastName: string;
}

/** Six persons «Person A Seedprobe» to «Person F Seedprobe». */
export const persons: readonly PersonSpec[] = (
  ['A', 'B', 'C', 'D', 'E', 'F'] as const
).map((letter) => ({
  label: `p${letter}`,
  firstName: `Person ${letter}`,
  lastName: marker,
}));

/** A group of the seed with its members. */
export interface GroupSpec {
  readonly label: 'gH' | 'gT';
  readonly name: string;
  readonly members: readonly PersonLabel[];
}

/** Two groups with overlapping members. */
export const groups: readonly GroupSpec[] = [
  {
    label: 'gH',
    name: 'Seedprobe Hauskreis',
    members: ['pA', 'pB', 'pC', 'pD'],
  },
  {
    label: 'gT',
    name: 'Seedprobe Technikteam',
    members: ['pC', 'pD', 'pE', 'pF'],
  },
];

/** A song of the seed with its arrangements, the default one first. */
export interface SongSpec {
  readonly label: 'l1' | 'l2';
  readonly name: string;
  readonly arrangements: readonly {
    readonly label: string;
    readonly name: string;
    readonly key: string;
  }[];
}

/** Two songs, one with two arrangements. */
export const songs: readonly SongSpec[] = [
  {
    label: 'l1',
    name: 'Seedprobe Lied A',
    arrangements: [
      { label: 'l1a', name: 'Standard', key: 'G' },
      { label: 'l1b', name: 'Tief', key: 'E' },
    ],
  },
  {
    label: 'l2',
    name: 'Seedprobe Lied B',
    arrangements: [{ label: 'l2a', name: 'Standard', key: 'D' }],
  },
];

/** One assignment of a person to a service of an event. */
export interface AssignmentSpec {
  readonly label: string;
  readonly service: ServiceSpec['label'];
  readonly person: PersonLabel;
  /** Whether the assignment is confirmed, as if the person had accepted it. */
  readonly accept: boolean;
}

/** One item of the agenda of an event. */
export type AgendaItemSpec =
  | { readonly label: string; readonly type: 'header'; readonly title: string }
  | {
      readonly label: string;
      readonly type: 'text';
      readonly title: string;
      readonly duration: number;
    }
  | { readonly label: string; readonly type: 'song'; readonly song: 'l1' };

/** The event an appointment carries. */
export interface EventSpec {
  readonly label: 'e1' | 'e2';
  readonly services: readonly {
    readonly service: ServiceSpec['label'];
    readonly count: number;
  }[];
  readonly assignments: readonly AssignmentSpec[];
  readonly agenda: readonly AgendaItemSpec[];
}

/** An appointment of the seed in its calendar. */
export interface AppointmentSpec {
  readonly label: 'a1' | 'a2' | 'a3' | 'a4';
  readonly title: string;
  /** Start and end with time, or whole days for an appointment over the day. */
  readonly when:
    | { readonly kind: 'time'; readonly start: Date; readonly end: Date }
    | { readonly kind: 'day'; readonly day: Date };
  /** For a weekly series: the last day it occurs. */
  readonly weeklyUntil?: Date;
  readonly event?: EventSpec;
  /** Whether the appointment books the resource of the seed. */
  readonly booksResource: boolean;
}

/** A booking of the resource without an appointment. */
export interface BookingSpec {
  readonly label: 'b1';
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
}

/** A page of the wiki. */
export interface PageSpec {
  readonly label: 'w1' | 'w2' | 'w3';
  readonly title: string;
  readonly isMarkdown: boolean;
  readonly text: string;
}

/** Everything of the seed that hangs on the day of the run. */
export interface DatedData {
  readonly saturday: Date;
  readonly appointments: readonly AppointmentSpec[];
  readonly bookings: readonly BookingSpec[];
}

/**
 * Builds the appointments and bookings for a run.
 *
 * @param now - The time of the run.
 * @returns The data with dates from the next Saturday on.
 */
export function datedData(now: Date): DatedData {
  const saturday = anchorSaturday(now);
  return {
    saturday,
    appointments: [
      {
        label: 'a1',
        title: 'Seedprobe Jugendabend',
        when: {
          kind: 'time',
          start: at(saturday, 0, 18),
          end: at(saturday, 0, 20),
        },
        event: {
          label: 'e1',
          services: [{ service: 's1', count: 1 }],
          assignments: [
            { label: 'e1s1pD', service: 's1', person: 'pD', accept: false },
          ],
          agenda: [],
        },
        booksResource: false,
      },
      {
        label: 'a2',
        title: 'Seedprobe Gottesdienst',
        when: {
          kind: 'time',
          start: at(saturday, 1, 9),
          end: at(saturday, 1, 10.5),
        },
        event: {
          label: 'e2',
          services: [
            { service: 's1', count: 1 },
            { service: 's2', count: 2 },
          ],
          assignments: [
            { label: 'e2s1pA', service: 's1', person: 'pA', accept: true },
            { label: 'e2s2pB', service: 's2', person: 'pB', accept: false },
            { label: 'e2s2pC', service: 's2', person: 'pC', accept: false },
          ],
          agenda: [
            { label: 'e2i1', type: 'header', title: 'Ankommen' },
            { label: 'e2i2', type: 'song', song: 'l1' },
            { label: 'e2i3', type: 'text', title: 'Predigt', duration: 1800 },
          ],
        },
        booksResource: false,
      },
      {
        label: 'a3',
        title: 'Seedprobe Gebetsabend',
        when: {
          kind: 'time',
          start: at(saturday, 4, 18.5),
          end: at(saturday, 4, 19.5),
        },
        weeklyUntil: at(saturday, 25),
        booksResource: false,
      },
      {
        label: 'a4',
        title: 'Seedprobe Gemeindeausflug',
        when: { kind: 'day', day: at(saturday, 7) },
        booksResource: true,
      },
    ],
    bookings: [
      {
        label: 'b1',
        title: 'Seedprobe Technikprobe',
        start: at(saturday, 0, 14),
        end: at(saturday, 0, 16),
      },
    ],
  };
}

const longParagraph =
  'Dieser Abschnitt ist synthetisch. Er steht nur hier, damit die Seite lang genug ist, um sie in Teilen zu lesen. Kein Satz nennt eine Person, eine Gemeinde oder einen Ort.';

/** The pages of the wiki: Markdown, HTML and one long page in Markdown. */
export const pages: readonly PageSpec[] = [
  {
    label: 'w1',
    title: 'Seedprobe Markdown',
    isMarkdown: true,
    text: [
      '# Seedprobe Markdown',
      '',
      'Diese Seite ist synthetisch. Der Seed der Testinstanz hat sie angelegt.',
      '',
      '## Liste',
      '',
      '- Punkt eins',
      '- Punkt zwei',
      '',
      '## Tabelle',
      '',
      '| Spalte A | Spalte B |',
      '| -------- | -------- |',
      '| eins     | zwei     |',
      '',
      'Ein Link auf [example.org](https://example.org).',
      '',
    ].join('\n'),
  },
  {
    label: 'w2',
    title: 'Seedprobe HTML',
    isMarkdown: false,
    text: '<h2>Seedprobe HTML</h2><p>Diese Seite ist synthetisch und in HTML geschrieben.</p><ul><li>Punkt eins</li><li>Punkt zwei</li></ul>',
  },
  {
    label: 'w3',
    title: 'Seedprobe lange Seite',
    isMarkdown: true,
    text: [
      '# Seedprobe lange Seite',
      '',
      ...Array.from({ length: 300 }, (_, index) => [
        `## Abschnitt ${String(index + 1)}`,
        '',
        longParagraph,
        '',
      ]).flat(),
    ].join('\n'),
  },
];
