/**
 * Answers of the search in the wiki and of the global search in the form
 * ChurchTools gives them, for the tests of their reads (ADR 0064). Every
 * field a read does not pass on holds a canary, so a test can show that no
 * layer lets one of them through. The fields kept take the values the test
 * gives, also the type of each hit, which the client checks.
 *
 * The names of the fields are those of the answers of ChurchTools 3.137, as
 * `08-persons-groups-read` and `09-domains-read` described them
 * (`docs/research/churchtools-api.md`, F25, F40): 12 fields of a hit of the
 * global search, whose `domainAttributes` hold the names of a person, the
 * attributes of a group, an empty list for a song and the category for a
 * page, and 13 fields of a hit of the search in the wiki with its preview.
 * The values are not those types: every value outside the kept ones is a
 * canary text. Where the probe could not name a key, `unnamed` stands in
 * for it.
 *
 * @packageDocumentation
 */
import type { SearchDomainType } from '@ecclium/mcp-churchtools-plugin-api';

import { type Canary, type CanaryKind } from '../canary.js';
import {
  answer,
  type HighestLevelAnswer,
  personAttributes,
  plant,
  type Shape,
} from './highest-level.js';

const text: CanaryKind = 'name';

// The attributes each type of hit carries in the global search. The names
// of a person stand there as well, outside the title a read keeps (F25).
const attributesOf: Readonly<Record<SearchDomainType, Shape>> = {
  person: personAttributes,
  group: {
    note: text,
    groupStatusId: text,
    groupTypeId: text,
    campusId: text,
    visibility: text,
    guid: 'token',
  },
  song: [text],
  wiki_page: { wikiCategoryId: text },
};

// The fields of a hit of the global search a read never keeps (F40).
const globalHitShape = (
  type: SearchDomainType,
): Readonly<Record<string, Shape>> => ({
  type: text,
  icon: text,
  apiUrl: 'token',
  frontendUrl: 'token',
  imageUrl: 'token',
  domainAttributes: attributesOf[type],
  infos: [text],
  color: text,
  initials: text,
});

/** A hit as a test gives it, with the type and identifier ChurchTools sends. */
export interface SearchHitFixture {
  /** The type of the hit, as ChurchTools sends it in `domainType`. */
  readonly domainType: string;
  /** The identifier, as ChurchTools sends it in `domainIdentifier`. */
  readonly domainIdentifier: string | number;
  /** The title. */
  readonly title: string;
}

/**
 * Builds an answer of `GET /api/search` for one type: each hit with every
 * field, its type, identifier and title from the hits given, every other
 * field a canary: `type`, the links, the icon, the initials, the infos and
 * `domainAttributes` in the form of the type, for a person with both names,
 * also the count in `meta`.
 *
 * @param type - The type searched for, which sets the form of the attributes.
 * @param hits - The hits, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = globalSearchAnswer('song', [
 *   { domainType: 'song', domainIdentifier: '2', title: 'Lied A' },
 * ]);
 * ```
 */
export function globalSearchAnswer(
  type: SearchDomainType,
  hits: readonly SearchHitFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const shape = globalHitShape(type);
  const data = hits.map((hit) => ({
    title: hit.title,
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    domainType: hit.domainType,
    domainIdentifier: hit.domainIdentifier,
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

// The fields of a hit of the search in the wiki a read never keeps (F40).
const wikiHitShape: Readonly<Record<string, Shape>> = {
  unnamed: text,
  icon: text,
  initials: text,
  color: text,
  apiUrl: 'token',
  frontendUrl: 'token',
  imageUrl: 'token',
  infos: [text],
};

/** A hit of the search in the wiki as a test gives it. */
export interface WikiSearchHitFixture extends SearchHitFixture {
  /**
   * The category as ChurchTools sends it in `domainAttributes`; the whole
   * `domainAttributes` is left out when undefined.
   */
  readonly wikiCategoryId?: number | string | null;
  /** The preview; left out of the answer when undefined. */
  readonly preview?: string | null;
}

/**
 * Builds an answer of `GET /api/wiki/search`: each hit with every field,
 * its type, identifier, title, category and preview from the hits given,
 * every other field a canary: the key the probe could not name, the links,
 * the icon, the initials and the infos, also the count in `meta`.
 *
 * @param hits - The hits, in the order of the answer.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = wikiSearchAnswer([{ domainType: 'wiki_page',
 *   domainIdentifier: '00000000-0000-4000-8000-000000000001', wikiCategoryId: 12,
 *   title: 'Seite A', preview: 'Ein Ausschnitt' }]);
 * ```
 */
export function wikiSearchAnswer(
  hits: readonly WikiSearchHitFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const data = hits.map((hit) => ({
    title: hit.title,
    ...(plant(wikiHitShape, 'entry', made) as Record<string, unknown>),
    domainType: hit.domainType,
    domainIdentifier: hit.domainIdentifier,
    ...(hit.wikiCategoryId === undefined
      ? {}
      : { domainAttributes: { wikiCategoryId: hit.wikiCategoryId } }),
    ...(hit.preview === undefined ? {} : { preview: hit.preview }),
  }));
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}
