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
 * The most categories of the wiki the core reads. ChurchTools lists every
 * category the account may see in one answer, without pages; a longer
 * list is no answer the core knows.
 */
export const maxWikiCategories = 1000;

/**
 * The most pages of the wiki one page of their list holds. 25 titles of
 * 255 characters fit into one result of a tool even when every character
 * doubles in length when it is written as JSON.
 */
export const wikiPageListLimit = 25;

/** The last page of the list of pages of a category a read may ask for. */
export const maxWikiListPage = 1000;

/** The longest name of a category and title of a page of the wiki. */
export const maxWikiTitleLength = 255;

/** A category of the wiki: only ID and name. */
export interface WikiCategory {
  /** The numeric ID of the category. */
  readonly id: number;
  /** Name of the category, at most 255 characters, possibly empty. */
  readonly name: string;
}

/** A page of the wiki in a list, without its text. */
export interface WikiPageEntry {
  /** The GUID of the page, the only way the core addresses a page. */
  readonly guid: string;
  /** Title of the page, at most 255 characters, possibly empty. */
  readonly title: string;
  /** Whether the page is written in Markdown; otherwise it is HTML. */
  readonly isMarkdown: boolean;
  /** The version of the page, which grows with every change of its text. */
  readonly version: number;
}

/** One page of the list of pages of a category. */
export interface WikiPageList {
  /** At most {@link wikiPageListLimit} pages, in the order of ChurchTools. */
  readonly pages: readonly WikiPageEntry[];
  /**
   * Whether ChurchTools reports a later page of the list. It comes from the
   * pagination of ChurchTools, which may count pages the account cannot
   * see, so a later page can be empty.
   */
  readonly more: boolean;
}

/** A page of the wiki with its text, in one version. */
export interface WikiPage extends WikiPageEntry {
  /** The whole text, Markdown or HTML, as ChurchTools stores it. */
  readonly text: string;
}

/**
 * The form of the GUID of a wiki page, as the OpenAPI document of
 * ChurchTools gives it, for {@link isWikiPageGuid} and for the input
 * schemas of tools.
 */
export const wikiPageGuidPattern: RegExp =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Whether a value has the form of the GUID of a wiki page, as the OpenAPI
 * document of ChurchTools gives it. The core addresses pages only by GUID,
 * because ChurchTools reports `identifier` as deprecated (ADR 0057), and
 * only a value of this form ever fills a path.
 *
 * @param value - The value to check.
 * @returns Whether it is a GUID.
 * @example
 * ```ts
 * isWikiPageGuid('00000000-0000-4000-8000-000000000001'); // true
 * isWikiPageGuid('../whoami'); // false
 * ```
 */
export function isWikiPageGuid(value: unknown): value is string {
  return typeof value === 'string' && wikiPageGuidPattern.test(value);
}

/**
 * The most memberships the groups of a person pass on. ChurchTools lists
 * them in one answer without pages; a longer list says so with `more`
 * (ADR 0064).
 */
export const maxPersonGroups = 50;

/**
 * The most members one page of the members of a group holds. Every page
 * counts against the read budget, so a list of persons serves no export
 * in one call (ADR 0064).
 */
export const groupMembersPageLimit = 50;

/** The last page of the members of a group a read may ask for. */
export const maxGroupMembersPage = 1000;

/**
 * The longest name of a person, of a group, of an event, of a calendar, of
 * a service, of a group of services and of an agenda, and the longest
 * title of an item of an agenda, of a song and of an arrangement.
 */
export const maxNameLength = 255;

/** The longest meeting time of a group the core reads. */
export const maxGroupMeetingTimeLength = 255;

/**
 * The longest note of a group the core reads, in UTF-16 code units. It
 * keeps one group with its note within one result of a tool, even when
 * every character doubles in length when it is written as JSON.
 */
export const maxGroupNoteLength = 10_000;

/**
 * The form of the status of a membership, such as `active`: a word
 * ChurchTools sets, not text people write, so it needs no data envelope.
 * Any other form is no answer the core knows.
 */
export const groupMemberStatusPattern: RegExp = /^[a-z_]{1,32}$/;

/**
 * The form of a date without time, as ChurchTools writes the start of a
 * membership (`docs/research/churchtools-api.md`, F32). The founding and
 * the end of a group take only this form until a probe shows theirs.
 */
export const calendarDatePattern: RegExp =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/;

/**
 * One person, read by ID: only ID, names and whether the person is
 * archived, as ChurchTools gives them to an account without a security
 * level (ADR 0064). Either name may be empty.
 */
export interface Person {
  /** The numeric ID of the person. */
  readonly id: number;
  /** First name, at most {@link maxNameLength} characters. */
  readonly firstName: string;
  /** Last name, at most {@link maxNameLength} characters. */
  readonly lastName: string;
  /** Whether the person is archived. */
  readonly isArchived: boolean;
}

/** A group a person belongs to, with the role and status of the membership. */
export interface PersonGroup {
  /**
   * The numeric ID of the group, or `null` when ChurchTools names it with
   * another identifier than a whole number from 1.
   */
  readonly groupId: number | null;
  /** Name of the group, at most {@link maxNameLength} characters. */
  readonly groupName: string;
  /** The ID of the role of the person in the group. */
  readonly groupTypeRoleId: number;
  /** The status of the membership, see {@link groupMemberStatusPattern}. */
  readonly groupMemberStatus: string;
}

/** The groups of one person. */
export interface PersonGroupList {
  /** At most {@link maxPersonGroups}, in the order of ChurchTools. */
  readonly groups: readonly PersonGroup[];
  /** Whether ChurchTools listed more groups than the list holds. */
  readonly more: boolean;
}

/**
 * What the lowest security level of groups adds to a group (ADR 0064). A
 * text or number the group lacks is `null`.
 */
export interface GroupDetails {
  /** When the group meets, as people of the congregation wrote it. */
  readonly meetingTime: string | null;
  /** The note of the group, text people of the congregation wrote. */
  readonly note: string | null;
  /** The most members the group takes. */
  readonly maxMembers: number | null;
  /** The ID of the target group. */
  readonly targetGroupId: number | null;
  /** The day the group was founded, see {@link calendarDatePattern}. */
  readonly dateOfFoundation: string | null;
  /** The day the group ends, see {@link calendarDatePattern}. */
  readonly endDate: string | null;
}

/** One group, read by ID. */
export interface Group {
  /** The numeric ID of the group. */
  readonly id: number;
  /** Name of the group, at most {@link maxNameLength} characters. */
  readonly name: string;
  /**
   * The details of the lowest security level, or `null` when ChurchTools
   * sent none of them: the account then lacks that level for the group.
   */
  readonly details: GroupDetails | null;
}

/** A member of a group, with the role and status of the membership. */
export interface GroupMember {
  /** The numeric ID of the person. */
  readonly personId: number;
  /** First name, at most {@link maxNameLength} characters. */
  readonly firstName: string;
  /** Last name, at most {@link maxNameLength} characters. */
  readonly lastName: string;
  /** The ID of the role of the person in the group. */
  readonly groupTypeRoleId: number;
  /** The status of the membership, see {@link groupMemberStatusPattern}. */
  readonly groupMemberStatus: string;
}

/** One page of the members of a group. */
export interface GroupMemberList {
  /** At most {@link groupMembersPageLimit}, in the order of ChurchTools. */
  readonly members: readonly GroupMember[];
  /**
   * Whether ChurchTools reports a later page. It comes from the pagination
   * of ChurchTools, which may count members the account cannot see, so a
   * later page can be empty.
   */
  readonly more: boolean;
}

/**
 * The form of a date with time, as ChurchTools writes the start and end of
 * an event and the start of an item of an agenda: with «T», seconds,
 * without fractions and with `Z` (`docs/research/churchtools-api.md`, F37).
 * Any other form is no answer the core knows.
 */
export const dateTimePattern: RegExp =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

/**
 * The most days a list of events covers, both ends included (ADR 0064).
 * A list of events takes a span of time instead of pages, because `page`
 * showed no effect there (F38).
 */
export const maxEventDays = 31;

/**
 * The most events a list passes on, the earliest first. The core asks
 * ChurchTools for one more, so that it can tell whether more follow
 * (ADR 0064).
 */
export const maxEvents = 50;

/**
 * The longest note of an event the core reads, in UTF-16 code units. Note
 * and description together keep one event within one result of a tool,
 * even when every character grows to six bytes there.
 */
export const maxEventNoteLength = 2_000;

/** The longest description of an event the core reads, see the note. */
export const maxEventDescriptionLength = 7_000;

/**
 * The most items of one agenda the core reads. ChurchTools gives an agenda
 * in one answer; a longer one is no answer the core knows.
 */
export const maxAgendaItems = 500;

/** The longest note of an item of an agenda the core reads. */
export const maxAgendaNoteLength = 1_000;

/**
 * The form of the type of an item of an agenda: a word ChurchTools sets,
 * not text people write, so it needs no data envelope. Any other form is no
 * answer the core knows.
 */
export const agendaItemTypePattern: RegExp = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * The most services and the most groups of services the core reads.
 * ChurchTools lists each in one answer; a longer list is no answer the
 * core knows.
 */
export const maxServices = 1000;

/**
 * The most assignments of one event the core reads. ChurchTools gives them
 * with the event; a longer list is no answer the core knows.
 */
export const maxEventAssignments = 500;

// Whether a value is a day of the calendar that exists, in the form of
// calendarDatePattern, so that 2026-02-30 is refused like a wrong form.
const dayOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !calendarDatePattern.test(value)) {
    return undefined;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
};

/**
 * Whether two days span a list of events: both days of the calendar that
 * exist, as `JJJJ-MM-TT` (see {@link calendarDatePattern}), the last not
 * before the first, and at most {@link maxEventDays} days, both ends
 * included. Only such a span ever reaches ChurchTools.
 *
 * @param from - The first day.
 * @param to - The last day.
 * @returns Whether the span fits.
 * @example
 * ```ts
 * isEventWindow('2026-10-01', '2026-10-31'); // true
 * isEventWindow('2026-10-01', '2026-11-01'); // false, 32 days
 * ```
 */
export function isEventWindow(from: unknown, to: unknown): boolean {
  const first = dayOf(from);
  const last = dayOf(to);
  if (first === undefined || last === undefined || last < first) return false;
  return (last - first) / 86_400_000 + 1 <= maxEventDays;
}

/**
 * An event in a list: what ChurchTools gives to an account with the right
 * to see the events of its calendar (ADR 0064).
 */
export interface EventEntry {
  /** The numeric ID of the event. */
  readonly id: number;
  /** Name of the event, at most {@link maxNameLength} characters. */
  readonly name: string;
  /** The start, see {@link dateTimePattern}. */
  readonly startDate: string;
  /** The end, see {@link dateTimePattern}. */
  readonly endDate: string;
  /** Whether the event is canceled. */
  readonly isCanceled: boolean;
  /**
   * The numeric ID of the calendar, or `null` when ChurchTools names it with
   * another identifier than a whole number from 1.
   */
  readonly calendarId: number | null;
  /** Name of the calendar, at most {@link maxNameLength} characters. */
  readonly calendarName: string;
}

/** The events of a span of days. */
export interface EventList {
  /**
   * At most {@link maxEvents}, sorted by their start, then by ID, so that
   * the same answer always gives the same list.
   */
  readonly events: readonly EventEntry[];
  /** Whether ChurchTools gave more events than the list holds. */
  readonly more: boolean;
}

/** One event, read by ID, with its note and description, never assignments. */
export interface EventDetails extends EventEntry {
  /**
   * The note of the event, text people wrote, at most
   * {@link maxEventNoteLength} code units, or `null` without one.
   */
  readonly note: string | null;
  /**
   * The description of the event, text people wrote, at most
   * {@link maxEventDescriptionLength} code units, or `null` without one.
   */
  readonly description: string | null;
}

/** The song of an item of an agenda, as the agenda names it. */
export interface AgendaSong {
  /** The numeric ID of the song. */
  readonly songId: number;
  /** The numeric ID of the arrangement, or `null` without one. */
  readonly arrangementId: number | null;
  /** Title of the song, at most {@link maxNameLength} characters. */
  readonly title: string;
  /** Name of the arrangement, or `null` without one. */
  readonly arrangement: string | null;
}

/** An item of an agenda, without the persons responsible for it. */
export interface AgendaItem {
  /** The position of the item in the agenda. */
  readonly position: number;
  /** The type of the item, see {@link agendaItemTypePattern}. */
  readonly type: string;
  /** Title of the item, at most {@link maxNameLength} characters. */
  readonly title: string;
  /** The start, see {@link dateTimePattern}, or `null` without one. */
  readonly start: string | null;
  /** The duration in seconds, or `null` without one. */
  readonly duration: number | null;
  /** Whether the item comes before the event starts. */
  readonly isBeforeEvent: boolean;
  /**
   * The note of the item, text people wrote, at most
   * {@link maxAgendaNoteLength} code units, or `null` without one.
   */
  readonly note: string | null;
  /** The song of the item, or `null` for an item without one. */
  readonly song: AgendaSong | null;
}

/** The agenda of one event. */
export interface Agenda {
  /** Name of the agenda, at most {@link maxNameLength} characters. */
  readonly name: string;
  /** Whether the agenda is final. */
  readonly isFinal: boolean;
  /** At most {@link maxAgendaItems}, in the order of ChurchTools. */
  readonly items: readonly AgendaItem[];
}

/** A service, such as a team role of an event. */
export interface Service {
  /** The numeric ID of the service. */
  readonly id: number;
  /** Name of the service, at most {@link maxNameLength} characters. */
  readonly name: string;
  /** The numeric ID of the group of services it belongs to. */
  readonly serviceGroupId: number;
  /**
   * Whether the service hides the names of the persons assigned to it. The
   * core then passes on no person of its assignments (ADR 0064).
   */
  readonly hidesNames: boolean;
}

/** A group of services. */
export interface ServiceGroup {
  /** The numeric ID of the group. */
  readonly id: number;
  /** Name of the group, at most {@link maxNameLength} characters. */
  readonly name: string;
}

/** The services and groups of services of the instance. */
export interface ServiceList {
  /** At most {@link maxServices}, sorted by ID. */
  readonly services: readonly Service[];
  /** At most {@link maxServices}, sorted by ID. */
  readonly serviceGroups: readonly ServiceGroup[];
}

/** The person assigned to a service, when the core may name it. */
export interface AssignedPerson {
  /** The numeric ID of the person. */
  readonly personId: number;
  /** First name, at most {@link maxNameLength} characters. */
  readonly firstName: string;
  /** Last name, at most {@link maxNameLength} characters. */
  readonly lastName: string;
}

/** An assignment of a person to a service of an event. */
export interface Assignment {
  /** The numeric ID of the service. */
  readonly serviceId: number;
  /**
   * Name of the service, or `null` when the service is missing in the list
   * of services.
   */
  readonly serviceName: string | null;
  /** Whether the assigned person accepted. */
  readonly isAccepted: boolean;
  /** Whether the assignment is agreed. */
  readonly agreed: boolean;
  /**
   * The assigned person, or `null`: when the service hides the names, when
   * it is missing in the list of services, or when ChurchTools gives no
   * whole number from 1 as the ID of the person (ADR 0064). The person who
   * requested the assignment is never read.
   */
  readonly person: AssignedPerson | null;
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
  /**
   * Reads one person by its numeric ID, with ID, names and whether it is
   * archived, never any other field (ADR 0064).
   *
   * @param personId - The ID of the person, a whole number from 1.
   * @returns The person.
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before any request; `permission` when the account may not
   *   see the area of the person; `not_found` for a person that does not
   *   exist; every error of the request.
   */
  person(personId: number): Promise<Person>;
  /**
   * Reads the groups of one person, with role and status of each
   * membership. An empty list can also mean that the account may not see
   * the person or the type of a group: ChurchTools then answers with an
   * empty list, not with an error.
   *
   * @param personId - The ID of the person, a whole number from 1.
   * @returns At most {@link maxPersonGroups} groups.
   * @throws {EccliumError} As {@link ReadApi.person}.
   */
  personGroups(personId: number): Promise<PersonGroupList>;
  /**
   * Reads one group by its numeric ID, with name and the details of the
   * lowest security level of groups (ADR 0064).
   *
   * @param groupId - The ID of the group, a whole number from 1.
   * @returns The group.
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before any request; `permission` when the account may not
   *   see the type of the group; `not_found` for a group that does not
   *   exist; every error of the request.
   */
  group(groupId: number): Promise<Group>;
  /**
   * Lists one page of the members of a group, with names, role and status.
   * ChurchTools leaves out members the account may not see, without an
   * entry in their place, and answers with an empty list when it may see
   * none of them.
   *
   * @param groupId - The ID of the group, a whole number from 1.
   * @param page - The page, from 1 to {@link maxGroupMembersPage}.
   * @returns At most {@link groupMembersPageLimit} members.
   * @throws {EccliumError} `validation` for an ID or page that does not
   *   fit, before any request; otherwise as {@link ReadApi.group}.
   */
  groupMembers(groupId: number, page: number): Promise<GroupMemberList>;
  /**
   * Lists the categories of the wiki the account may see, with ID and name.
   *
   * @returns All of them, in the order of ChurchTools, at most
   *   {@link maxWikiCategories}.
   * @throws {EccliumError} `permission` without the right `view` in
   *   `churchwiki`; `upstream` for more than {@link maxWikiCategories};
   *   every error of the request.
   */
  wikiCategories(): Promise<readonly WikiCategory[]>;
  /**
   * Lists the pages of one category of the wiki, one page of the list at a
   * time, without their text. An empty list can also mean that the
   * account lacks the right to see the category: ChurchTools then answers
   * with an empty list, not with an error.
   *
   * @param categoryId - The ID of the category.
   * @param page - The page of the list, from 1 to {@link maxWikiListPage}.
   * @returns At most {@link wikiPageListLimit} pages.
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1 or a page outside 1 to {@link maxWikiListPage}, before any
   *   request; every error of the request.
   */
  wikiPages(categoryId: number, page: number): Promise<WikiPageList>;
  /**
   * Reads one page of the wiki with its whole text, in its newest version
   * or in the version asked for.
   *
   * @param categoryId - The ID of the category of the page.
   * @param guid - The GUID of the page, see {@link isWikiPageGuid}.
   * @param version - The version to read; the newest when left out.
   * @returns The page.
   * @throws {EccliumError} `validation` for an ID, GUID or version that does
   *   not fit, before any request; `permission` without the right to see
   *   the category; `not_found` for a page or version that does not exist;
   *   every error of the request.
   */
  wikiPage(
    categoryId: number,
    guid: string,
    version?: number,
  ): Promise<WikiPage>;
  /**
   * Lists the events of a span of days, of the calendars whose events the
   * account may see. An empty list can also mean that the account lacks
   * that right: ChurchTools then answers with an empty list, not with an
   * error.
   *
   * @param from - The first day, see {@link isEventWindow}.
   * @param to - The last day, see {@link isEventWindow}.
   * @returns At most {@link maxEvents} events.
   * @throws {EccliumError} `validation` for a span that does not fit, before
   *   any request; every error of the request.
   */
  events(from: string, to: string): Promise<EventList>;
  /**
   * Reads one event by its numeric ID, with note and description, never
   * its assignments (ADR 0064).
   *
   * @param eventId - The ID of the event, a whole number from 1.
   * @returns The event.
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before any request; `permission` when the account may not see
   *   the events of its calendar; `not_found` for an event that does not
   *   exist; every error of the request.
   */
  event(eventId: number): Promise<EventDetails>;
  /**
   * Reads the agenda of one event, without the persons responsible for its
   * items. ChurchTools gives it with the right to see the agendas of the
   * calendar, also without the right to see the event.
   *
   * @param eventId - The ID of the event, a whole number from 1.
   * @returns The agenda.
   * @throws {EccliumError} `validation` for an ID that is no whole number
   *   from 1, before any request; `permission` when the account may not see
   *   the agendas of the calendar; `not_found` for an event without agenda
   *   or one that does not exist; every error of the request.
   */
  eventAgenda(eventId: number): Promise<Agenda>;
  /**
   * Lists the services and groups of services of the instance. ChurchTools
   * gives them to every account, without a right.
   *
   * @returns All of them.
   * @throws {EccliumError} `upstream` for more than {@link maxServices};
   *   every error of the request.
   */
  services(): Promise<ServiceList>;
  /**
   * Lists the assignments of persons to the services of one event, with the
   * name of each service. The core reads the services as well and passes
   * on a person only where it may name it (see {@link Assignment.person}).
   * An empty list can also mean that the account may not see the groups of
   * services: ChurchTools then gives the event without its assignments.
   *
   * @param eventId - The ID of the event, a whole number from 1.
   * @returns At most {@link maxEventAssignments}, in the order of
   *   ChurchTools.
   * @throws {EccliumError} `policy_denied` for a tool whose result does not
   *   wait for its line in the audit file (ADR 0064); otherwise as
   *   {@link ReadApi.event}.
   */
  eventAssignments(eventId: number): Promise<readonly Assignment[]>;
}
