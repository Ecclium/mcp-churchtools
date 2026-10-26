/**
 * The schemas of the answers of ChurchTools that the client reads
 * (ADR 0025, ADR 0057). `z.object` drops unknown keys; no schema transforms
 * a value. They carry no data classes: what the tools pass on gets its
 * classes in the tool schemas.
 *
 * @packageDocumentation
 */
import {
  agendaItemTypePattern,
  calendarDatePattern,
  dateTimePattern,
  groupMembersPageLimit,
  groupMemberStatusPattern,
  isWikiPageGuid,
  maxAgendaItems,
  maxAgendaNoteLength,
  maxEventAssignments,
  maxEventDescriptionLength,
  maxEventNoteLength,
  maxEvents,
  maxGroupMeetingTimeLength,
  maxGroupNoteLength,
  maxNameLength,
  maxSearchHits,
  maxServices,
  maxWikiCategories,
  maxWikiTitleLength,
  wikiPageListLimit,
} from '@ecclium/mcp-churchtools-plugin-api';
import { z } from 'zod';

const count = z.number().int().nonnegative();

/**
 * `meta.pagination` of a list with pages (`docs/research/churchtools-api.md`,
 * F6). `meta.all`, where it appears, is not read.
 */
export const paginationSchema = z.object({
  total: count,
  limit: count,
  current: count,
  lastPage: count,
});

/** `meta` of a list with pages. */
export const pagedMetaSchema = z.object({ pagination: paginationSchema });

/** `meta` of a list without pages, which only counts (F6). */
export const countedMetaSchema = z.object({ count });

// Whether a string has no lone surrogate, without String#isWellFormed,
// which the target of the compiler does not know.
const wellFormed = (text: string): boolean => {
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

const text = (max: number) =>
  z.string().max(max, { abort: true }).refine(wellFormed);

const id = z.number().int().positive();

/**
 * The answer of `GET /api/whoami` (`docs/research/churchtools-api.md`,
 * F18), only the fields the client passes on. `meta.simulatingUserId` must
 * be null or missing; the check for the anonymous person runs before it.
 */
export const whoamiSchema = z.object({
  data: z.object({
    id,
    guid: z.string().min(1).max(64, { abort: true }).refine(wellFormed),
    firstName: text(255),
    lastName: text(255),
    // Missing for an account that may not see persons: ChurchTools then
    // sends 17 fields of the person instead of 40, without the e-mail.
    email: text(254).nullable().optional(),
  }),
  meta: z.object({ simulatingUserId: z.null().optional() }).optional(),
});

/**
 * The most entries a search asks for: one more than it gives, so that a
 * further visible entry says there are more hits (ADR 0060).
 */
export const searchPageLimit = maxSearchHits + 1;

/**
 * The answer of `GET /api/persons` with `query`, only the fields a search
 * passes on (ADR 0060, `docs/research/churchtools-api.md`, F25, F32). The
 * names come without a security level and may be empty; `null` or a
 * missing name is an error, never a hit without a name. `meta` is not
 * read: whether its counts include persons the account may not see is
 * open (F26).
 */
export const personListSchema = z.object({
  data: z
    .array(z.object({ id, firstName: text(255), lastName: text(255) }))
    .max(searchPageLimit),
});

/**
 * The answer of `GET /api/groups` with `query`, only ID and name of each
 * group (ADR 0060, F25, F32). The name is the same top-level field at every
 * security level of groups.
 */
export const groupListSchema = z.object({
  data: z.array(z.object({ id, name: text(255) })).max(searchPageLimit),
});

/**
 * The answer of `GET /api/persons/{personId}`, only the four fields the
 * read passes on (ADR 0064, `docs/research/churchtools-api.md`, F32). The
 * names come without a security level and may be empty; `guid` and every
 * other field are not read.
 */
export const personSchema = z.object({
  data: z.object({
    id,
    firstName: text(maxNameLength),
    lastName: text(maxNameLength),
    isArchived: z.boolean(),
  }),
});

/**
 * The most groups of one person the client reads. ChurchTools lists them
 * in one answer without pages (F26); a longer list is no answer the client
 * knows. The read passes on the first 50 of them.
 */
export const maxPersonGroupEntries = 1000;

const memberStatus = z.string().regex(groupMemberStatusPattern);

/**
 * The answer of `GET /api/persons/{personId}/groups` without parameters,
 * only what the read passes on (ADR 0064, F34): of the group the
 * identifier in `domainIdentifier` and the name in `title`, and role and
 * status of the membership. The object `person`, whose names ChurchTools
 * leaves empty here, and `meta` are not read.
 */
export const personGroupListSchema = z.object({
  data: z
    .array(
      z.object({
        group: z.object({
          // Any text up to this length; only a plain whole number from 1
          // becomes the ID of the group, any other gives none (ADR 0064).
          domainIdentifier: z.string().max(maxNameLength, { abort: true }),
          title: text(maxNameLength),
        }),
        groupTypeRoleId: id,
        groupMemberStatus: memberStatus,
      }),
    )
    .max(maxPersonGroupEntries),
});

const calendarDate = z.string().regex(calendarDatePattern);

/**
 * The six details of the lowest security level of groups that the read
 * passes on (ADR 0064, F32), in the object `information`. Without that
 * level, ChurchTools leaves them out instead of sending `null`.
 */
const groupDetailsSchema = z.object({
  meetingTime: text(maxGroupMeetingTimeLength).nullable().optional(),
  note: text(maxGroupNoteLength).nullable().optional(),
  maxMembers: count.nullable().optional(),
  targetGroupId: id.nullable().optional(),
  dateOfFoundation: calendarDate.nullable().optional(),
  endDate: calendarDate.nullable().optional(),
});

const groupDetailKeys = Object.freeze(
  Object.keys(groupDetailsSchema.shape),
) as readonly (keyof z.output<typeof groupDetailsSchema>)[];

/**
 * The answer of `GET /api/groups/{groupId}`, only ID, name and the six
 * details (ADR 0064, F32). The details come all together or not at all: a
 * part of them is no form a probe has shown, so the client refuses it.
 * `settings.qrCodeCheckinAutomaticEmail`, the seventh field of the lowest
 * level, and every other field are not read.
 */
export const groupSchema = z.object({
  data: z.object({
    id,
    name: text(maxNameLength),
    information: groupDetailsSchema.refine((details) => {
      const present = groupDetailKeys.filter(
        (key) => details[key] !== undefined,
      ).length;
      return present === 0 || present === groupDetailKeys.length;
    }),
  }),
});

/**
 * One page of the answer of `GET /api/groups/{groupId}/members` without
 * `personFields[]` and `include`, only what the read passes on (ADR 0064,
 * F34): the ID and the names of the person, and role and status of the
 * membership. Of `meta`, only `pagination.lastPage` is read, for whether
 * another page follows; whether its counts include members the account
 * may not see is open (F26). A page with members must carry it.
 */
export const groupMemberListSchema = z
  .object({
    data: z
      .array(
        z.object({
          personId: id,
          person: z.object({
            domainAttributes: z.object({
              firstName: text(maxNameLength),
              lastName: text(maxNameLength),
            }),
          }),
          groupTypeRoleId: id,
          groupMemberStatus: memberStatus,
        }),
      )
      .max(groupMembersPageLimit),
    // Optional only for a page without members: whether ChurchTools sends
    // the pagination for a page behind the last one, no probe has shown
    // (F26). Such a page then says that no page follows.
    meta: z
      .object({ pagination: z.object({ lastPage: count }).optional() })
      .optional(),
  })
  .refine(
    (root) => root.meta?.pagination !== undefined || root.data.length === 0,
  );

const dateTime = z.string().regex(dateTimePattern);

/**
 * The most events the client asks for: one more than a list gives, so that
 * a further event says that more follow (ADR 0064).
 */
export const eventsRequestLimit = maxEvents + 1;

/**
 * The most events the client reads from one answer. Whether `limit` cuts
 * the list of events is not shown (F38): ChurchTools may send more than it
 * was asked for, up to this many. A longer list is no answer the client
 * knows.
 */
export const maxEventEntries = 1000;

// The calendar of an event, a reference of a domain (F37): only the
// identifier and the title. Any text up to this length as identifier; only
// a plain whole number from 1 becomes the ID of the calendar.
const calendarReference = z.object({
  domainIdentifier: z.string().max(maxNameLength, { abort: true }),
  title: text(maxNameLength),
});

const eventFields = {
  id,
  name: text(maxNameLength),
  startDate: dateTime,
  endDate: dateTime,
  isCanceled: z.boolean(),
  calendar: calendarReference,
};

/**
 * The answer of `GET /api/events` with `from`, `to` and `limit`, only the
 * fields a list passes on (ADR 0064, `docs/research/churchtools-api.md`,
 * F37). Note, description, the IDs of persons in `adminIds` and
 * `eventAdminIds`, the links of the calendar and `meta` are not read.
 */
export const eventListSchema = z.object({
  data: z.array(z.object(eventFields)).max(maxEventEntries),
});

/**
 * The answer of `GET /api/events/{eventId}` for the read of one event: the
 * fields of the list with note and description, never `eventServices`
 * (ADR 0064, F37). A note or description that is missing counts as none.
 */
export const eventSchema = z.object({
  data: z.object({
    ...eventFields,
    note: text(maxEventNoteLength).nullable().optional(),
    description: text(maxEventDescriptionLength).nullable().optional(),
  }),
});

/**
 * The answer of `GET /api/events/{eventId}` for the assignments: only
 * `eventServices`, each with the service, both states, the ID of the person
 * and the names of the assigned person (ADR 0064, F37). The person who
 * requested it, its ID, the comment and every field of the event are not
 * read. An assignment may name no person: the ID and the names may then be
 * missing or `null`, and the core passes on no person.
 */
export const eventAssignmentsSchema = z.object({
  data: z.object({
    eventServices: z
      .array(
        z.object({
          serviceId: id,
          isAccepted: z.boolean(),
          agreed: z.boolean(),
          // Any whole number or null: ChurchTools sent a number below 1 for
          // a service that hides the names (F37).
          personId: z.number().int().nullable().optional(),
          person: z
            .object({
              domainAttributes: z.object({
                firstName: text(maxNameLength).nullable().optional(),
                lastName: text(maxNameLength).nullable().optional(),
              }),
            })
            .nullable()
            .optional(),
        }),
      )
      .max(maxEventAssignments),
  }),
});

const agendaSong = z.object({
  songId: id,
  arrangementId: id.nullable().optional(),
  title: text(maxNameLength),
  arrangement: text(maxNameLength).nullable().optional(),
});

/**
 * The answer of `GET /api/events/{eventId}/agenda`, only what the read
 * passes on (ADR 0064, F37): name, whether final, and of each item its
 * position, type, title, start, duration, whether it comes before the
 * event, its note and its song. `responsible` and `serviceGroupNotes`,
 * whose form is not known, and `meta` are not read. A name or title of
 * `null` counts as empty, a missing start, duration, note or song as none.
 */
export const agendaSchema = z.object({
  data: z.object({
    name: text(maxNameLength).nullable(),
    isFinal: z.boolean(),
    items: z
      .array(
        z.object({
          position: z.number().int(),
          type: z.string().regex(agendaItemTypePattern),
          title: text(maxNameLength).nullable(),
          start: dateTime.nullable().optional(),
          duration: count.nullable().optional(),
          isBeforeEvent: z.boolean(),
          note: text(maxAgendaNoteLength).nullable().optional(),
          song: agendaSong.nullable().optional(),
        }),
      )
      .max(maxAgendaItems),
  }),
});

/**
 * The answer of `GET /api/services`, only ID, name, group and
 * `hidePersonName` of each service (ADR 0064, F37). Every account reads
 * it, without a right (F36).
 */
export const serviceListSchema = z.object({
  data: z
    .array(
      z.object({
        id,
        name: text(maxNameLength),
        serviceGroupId: id,
        hidePersonName: z.boolean(),
      }),
    )
    .max(maxServices),
});

/**
 * The answer of `GET /api/servicegroups`, only ID and name of each group
 * (ADR 0064, F37).
 */
export const serviceGroupListSchema = z.object({
  data: z.array(z.object({ id, name: text(maxNameLength) })).max(maxServices),
});

/**
 * The longest text of a wiki page the client reads, in UTF-16 code units.
 * The limit of the answer bounds it as well; a tool passes the text on in
 * parts.
 */
export const maxWikiTextLength = 2_000_000;

const pageGuid = z.string().refine(isWikiPageGuid);

/**
 * The answer of `GET /api/wiki/categories`, only ID and name of each
 * category. The gates of the probes read both, among other fields, before
 * every run against the test instance and refuse any other form
 * (`docs/research/churchtools-api.md`, «Kategorien des Wikis»). More than
 * {@link maxWikiCategories} is no answer the client knows.
 */
export const wikiCategoryListSchema = z.object({
  data: z
    .array(z.object({ id, name: text(maxWikiTitleLength) }))
    .max(maxWikiCategories),
});

/**
 * The answer of `GET /api/wiki/pages` for one category, only the fields a
 * list passes on (F6, F9, «Kennung einer Seite», «Listen ohne Text»).
 * `meta.createdPerson` and `meta.modifiedPerson`, which carry names of
 * persons, are not read (ADR 0057).
 */
export const wikiPageListSchema = z.object({
  data: z
    .array(
      z.object({
        guid: pageGuid,
        title: text(maxWikiTitleLength),
        isMarkdown: z.boolean(),
        version: id,
      }),
    )
    .max(wikiPageListLimit),
  meta: pagedMetaSchema,
});

/**
 * The answer of `GET /api/wiki/categories/{id}/pages/{guid}` and of one
 * version of a page, which has the same form (F19). `text` may be null for
 * a page without text; the client reads it as empty. The GUID comes from
 * the request, so the answer need not repeat it.
 */
export const wikiPageSchema = z.object({
  data: z.object({
    title: text(maxWikiTitleLength),
    isMarkdown: z.boolean(),
    version: id,
    text: text(maxWikiTextLength).nullable(),
  }),
});

/**
 * An ID in the list of a right. ChurchTools 3.137 lists 0 next to other IDs,
 * for categories of the wiki, songs and comments, stations and campus; older
 * tables count from 0. A 0 is an ID like any other and never means «all»
 * (ADR 0057).
 */
const rightId = z.number().int().nonnegative();

/** The value of one right: a boolean or a list of IDs (F5, F30). */
export const rightValueSchema = z.union([
  z.boolean(),
  z.array(rightId).max(10_000),
]);
