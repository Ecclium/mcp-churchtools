/**
 * The synthetic persons and groups the probe that reads persons looks for.
 *
 * The maintainer creates them by hand on the test instance, as the README
 * describes. Their names carry the marker «Spikeprobe», which nothing else
 * on the instance carries. The probe recognises them in its memory by
 * their names and never prints a name: in the output they appear only as
 * `p1` to `p4` and `g1`, `g2`. The search terms are fixed here, so no other
 * term reaches a request or the logs of the instance; the only other one
 * is a random UUID per run.
 *
 * @packageDocumentation
 */
import { isObject } from './spec.mts';

/** The marker in the names of the synthetic persons and groups. */
export const marker = 'Spikeprobe';

/** A part of the e-mail address of `p1` that appears in no name. */
export const emailToken = 'qzvx';

/** The labels under which the synthetic objects appear in the output. */
export const labels = ['p1', 'p2', 'p3', 'p4', 'g1', 'g2'] as const;

/** One label of a synthetic object. */
export type Label = (typeof labels)[number];

/** A synthetic person, by first and last name. */
export interface SyntheticPerson {
  readonly label: Label;
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * The synthetic persons: the marker as the last name, as the start of the
 * last name, as the first name, and inside the last name. `p4` belongs to
 * another area than the others, so it shows whether the rights of an area
 * hold; it is a member of `g1`, so the members of `g1` show whether a
 * member outside the visible area is left out.
 */
export const syntheticPersons: readonly SyntheticPerson[] = [
  { label: 'p1', firstName: 'Anna', lastName: 'Spikeprobe' },
  { label: 'p2', firstName: 'Bruno', lastName: 'Spikeprobenberg' },
  { label: 'p3', firstName: 'Spikeprobe', lastName: 'Carlsen' },
  { label: 'p4', firstName: 'Dora', lastName: 'Vorspikeprobe' },
];

/** A synthetic group, by name. */
export interface SyntheticGroup {
  readonly label: Label;
  readonly name: string;
}

/** The synthetic groups, one in each of two group types. */
export const syntheticGroups: readonly SyntheticGroup[] = [
  { label: 'g1', name: 'Spikeprobe Nord' },
  { label: 'g2', name: 'Spikeprobe West' },
];

/** The fixed search terms, by the label the output uses. */
export const searchQueries = [
  { label: 'q1', text: 'Spikeprobe' },
  { label: 'q2', text: 'spikeprobe' },
  { label: 'q3', text: 'Spikepro' },
  { label: 'q4', text: 'Anna Spikeprobe' },
  { label: 'q5', text: 'Spikeprobe Anna' },
  { label: 'q6', text: emailToken },
  // Inside the marker: a hit on p1 to p3 shows a match inside a word.
  { label: 'q7', text: 'ikeprob' },
] as const;

/** The label of the search term that is a random UUID of each run. */
export const unknownQueryLabel = 'q8';

/**
 * The fixed term the probe that reads the domains sends to the global
 * search, the word the names of its synthetic objects carry. The search of
 * the wiki takes the {@link marker}. Like every term here, it never
 * appears in an output.
 */
export const domainsQuery = 'Synthetisch';

// An empty text is no name: reduced persons carry an empty first name.
const lower = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value.toLowerCase() : undefined;

interface Names {
  readonly pairs: (readonly [string, string])[];
  readonly titles: string[];
}

function collect(value: unknown, names: Names, depth: number): void {
  if (!isObject(value) || depth > 3) {
    return;
  }
  const first = lower(value['firstName']);
  const last = lower(value['lastName']);
  if (first !== undefined && last !== undefined) {
    names.pairs.push([first, last]);
  }
  for (const key of ['name', 'title']) {
    const title = lower(value[key]);
    if (title !== undefined) {
      names.titles.push(title);
    }
  }
  for (const key of ['domainAttributes', 'person', 'group']) {
    collect(value[key], names, depth + 1);
  }
}

/**
 * Finds the synthetic objects one entry of an answer names.
 *
 * A person counts if the entry, its `person`, or the `domainAttributes` of
 * either carry its first and last name, or if a `title` is its full name.
 * A group counts if a `name` or `title` is its name. Case does not matter.
 *
 * @param entry - One entry of a list, or the data of a single answer.
 * @returns The labels of the objects it names, and whether it had any field to compare.
 */
export function syntheticIn(entry: unknown): {
  readonly found: ReadonlySet<Label>;
  readonly comparable: boolean;
} {
  const names: Names = { pairs: [], titles: [] };
  collect(entry, names, 0);
  const found = new Set<Label>();
  for (const person of syntheticPersons) {
    const first = person.firstName.toLowerCase();
    const last = person.lastName.toLowerCase();
    if (
      names.pairs.some(([a, b]) => a === first && b === last) ||
      names.titles.includes(`${first} ${last}`)
    ) {
      found.add(person.label);
    }
  }
  for (const group of syntheticGroups) {
    if (names.titles.includes(group.name.toLowerCase())) {
      found.add(group.label);
    }
  }
  return {
    found,
    comparable: names.pairs.length > 0 || names.titles.length > 0,
  };
}
