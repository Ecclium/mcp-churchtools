/**
 * What a tool may read from ChurchTools.
 *
 * @packageDocumentation
 */

/**
 * The account the server reads with, as `GET /api/whoami` describes it
 * (`docs/research/churchtools-api.md`, F18). Only the fields a tool needs.
 */
export interface Me {
  /** ID of the person behind the account. */
  readonly id: number;
  /** First name. */
  readonly firstName: string;
  /** Last name. */
  readonly lastName: string;
  /** E-mail address, or `null` when the account has none. */
  readonly email: string | null;
}

/** A right that is set: `true`, or a list of numbers, never empty. */
export type RightValue = true | readonly number[];

/**
 * The rights of the account by module and name, such as `churchwiki` and
 * `view` (`docs/research/churchtools-api.md`, F5). ChurchTools lists every
 * right, also those the account lacks; this holds only the set ones.
 */
export type GrantedRights = Readonly<
  Record<string, Readonly<Record<string, RightValue>>>
>;

/**
 * The rights of the account, or `unknown` when the answer of ChurchTools has
 * a structure the core does not know. An unknown structure blocks writing,
 * never reading.
 */
export type Permissions =
  | { readonly kind: 'known'; readonly granted: GrantedRights }
  | { readonly kind: 'unknown' };

/**
 * The most hits a search returns. It reads only the first page and never
 * pages on, so no search serves as an export (ADR 0060).
 */
export const maxSearchHits = 50;

/**
 * The longest search term in UTF-16 code units. It is enough for any name a
 * search can sensibly hit and keeps terms taken from foreign text short.
 */
export const maxSearchTermLength = 100;

/**
 * A person a search found: only ID and name, as ChurchTools gives them to
 * an account without a security level (ADR 0060). Either name may be empty.
 */
export interface PersonHit {
  /** The numeric ID of the person. */
  readonly id: number;
  /** First name, at most 255 characters. */
  readonly firstName: string;
  /** Last name, at most 255 characters. */
  readonly lastName: string;
}

/**
 * A group a search found: only ID and name (ADR 0060). The name is text
 * people of the congregation set, so a tool marks it as untrusted.
 */
export interface GroupHit {
  /** The numeric ID of the group. */
  readonly id: number;
  /** Name of the group, at most 255 characters, possibly empty. */
  readonly name: string;
}

/**
 * The hits of one search. `more` says that ChurchTools had another visible
 * entry beyond {@link maxSearchHits}; it counts only entries the account
 * may see and never comes from a total ChurchTools reports, which may count
 * hidden ones (ADR 0060).
 */
export interface SearchHits<Hit> {
  /** At most {@link maxSearchHits} hits, in the order of ChurchTools. */
  readonly hits: readonly Hit[];
  /** Whether there are more hits than the list holds. */
  readonly more: boolean;
}

// Whether a string has no lone surrogate, without String#isWellFormed,
// which the target of the compiler does not know.
const isWellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

// C0 controls, DEL and C1 controls. No name holds one, and a line break or
// a tab in a term only hides what is sent.
const hasControl = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/**
 * Brings a search term into the form a search sends: white space at both
 * ends removed, then 1 to {@link maxSearchTermLength} code units, well
 * formed and without control characters. An empty term is refused because
 * a list without a term shows every person or group the account may see.
 * Tools and the core use the same function, so a term the tool accepts is
 * one the core sends.
 *
 * @param value - The term as a tool or a plugin got it.
 * @returns The term to send, or `undefined` when it is not a search term.
 * @example
 * ```ts
 * normalizeSearchTerm('  Person A '); // 'Person A'
 * normalizeSearchTerm('   '); // undefined
 * ```
 */
export function normalizeSearchTerm(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const term = value.trim();
  if (
    term.length < 1 ||
    term.length > maxSearchTermLength ||
    !isWellFormed(term) ||
    hasControl(term)
  ) {
    return undefined;
  }
  return term;
}

/**
 * Reads from ChurchTools for one call of a tool, with the account of the
 * server and through the one outbound path of the core. A tool never sees a
 * token and cannot choose what host it reads from. The core revokes it when
 * the call ends: every method then rejects.
 *
 * It starts with what the first tools need and grows with the tools. Its
 * form may change until version 1.0 of this package.
 */
export interface ReadApi {
  /**
   * Reads the account of the server.
   *
   * @returns The account.
   */
  whoami(): Promise<Me>;
  /**
   * Reads the rights of the account of the server.
   *
   * @returns The set rights, or `unknown` for an unknown structure.
   */
  permissions(): Promise<Permissions>;
  /**
   * Searches persons by name, in the areas the account may see. A term
   * matches first or last name, or the first name followed by the last
   * name, also in part and in lower case; never an e-mail address. An
   * empty list can also mean that the account lacks the right to see the
   * area of a person: ChurchTools then answers with an empty list, not
   * with an error.
   *
   * @param query - The search term, see {@link normalizeSearchTerm}.
   * @returns At most {@link maxSearchHits} persons with ID and name.
   * @throws {EccliumError} `validation` for a term that is not a search
   *   term, before any request; every error of the request.
   */
  searchPersons(query: string): Promise<SearchHits<PersonHit>>;
  /**
   * Searches groups by name, of the group types the account may see, and
   * groups of the visibility «intern», which ChurchTools shows without any
   * right on groups. An empty list can also mean that the account lacks the
   * right to see the type of a group.
   *
   * @param query - The search term, see {@link normalizeSearchTerm}.
   * @returns At most {@link maxSearchHits} groups with ID and name.
   * @throws {EccliumError} `validation` for a term that is not a search
   *   term, before any request; every error of the request.
   */
  searchGroups(query: string): Promise<SearchHits<GroupHit>>;
}
