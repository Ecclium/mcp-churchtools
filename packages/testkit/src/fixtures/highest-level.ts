/**
 * Answers of persons and groups in the form an account with the highest
 * security levels gets them, for the tests of the search tools (ADR 0060)
 * and of the reads of one person, the groups of a person, one group and
 * its members (ADR 0064). Every field a tool does not pass on holds a
 * canary, so a test can show that no layer lets one of them through. The
 * fields kept take the values the test gives.
 *
 * The names of the fields are those of the answers of ChurchTools 3.137 at
 * the highest levels, as `08-persons-groups-read` described them
 * (`docs/research/churchtools-api.md`, F32): 62 fields of a person and 13
 * fields of a group at the top. The values are not those types: every
 * value outside the list is a canary text, so that each one can be found
 * again. The client drops the other fields by their names, not by their
 * types.
 *
 * @packageDocumentation
 */
import type {
  Group,
  GroupHit,
  GroupMember,
  Person,
  PersonHit,
} from '@ecclium/mcp-churchtools-plugin-api';

import { type Canary, type CanaryKind, makeCanary } from '../canary.js';

/**
 * The shape of an answer: a leaf holds a canary of its kind, an object
 * holds fields, a list holds one element of its shape. For the fixtures of
 * this package only.
 */
export type Shape =
  CanaryKind | { readonly [field: string]: Shape } | readonly [Shape];

const text: CanaryKind = 'name';

/** `meta` of an object, for the fixtures of this package only. */
export const meta: Shape = {
  createdDate: text,
  createdPerson: { id: text },
  modifiedDate: text,
  modifiedPerson: { id: text },
};

// Every field of a person but the three a search passes on.
const personShape: Readonly<Record<string, Shape>> = {
  guid: 'token',
  securityLevelForPerson: text,
  editSecurityLevelForPerson: text,
  title: text,
  nickname: text,
  job: text,
  street: text,
  addressAddition: text,
  zip: 'phone',
  city: text,
  country: text,
  latitude: 'phone',
  longitude: 'phone',
  latitudeLoose: 'phone',
  longitudeLoose: 'phone',
  phonePrivate: 'phone',
  phoneWork: 'phone',
  mobile: 'phone',
  fax: 'phone',
  birthName: text,
  birthday: 'phone',
  birthplace: text,
  age: 'phone',
  isDead: text,
  imageUrl: 'token',
  familyImageUrl: 'token',
  sexId: text,
  email: 'email',
  emails: [{ email: 'email', isDefault: text, contactLabelId: text }],
  cmsUserId: 'token',
  optigemId: 'token',
  privacyPolicyAgreement: { date: 'phone', typeId: text, whoId: text },
  privacyPolicyAgreementDate: 'phone',
  privacyPolicyAgreementTypeId: text,
  privacyPolicyAgreementWhoId: text,
  nationalityId: text,
  familyStatusId: text,
  weddingDate: 'phone',
  campusId: text,
  statusId: text,
  departmentIds: [text],
  firstContact: 'phone',
  dateOfBelonging: 'phone',
  dateOfDeath: 'phone',
  dateOfEntry: 'phone',
  dateOfResign: 'phone',
  dateOfBaptism: 'phone',
  placeOfBaptism: text,
  baptisedBy: text,
  referredBy: text,
  referredTo: text,
  growPathId: text,
  canChat: text,
  invitationStatus: text,
  chatActive: text,
  isArchived: text,
  visibility: text,
  acceptedsecurity: text,
  meta,
};

// Every field of a group but the two a search passes on. The probe could
// not name one key at the top level; `unnamed` stands in for it with its
// three texts.
const groupShape: Readonly<Record<string, Shape>> = {
  guid: 'token',
  securityLevelForGroup: text,
  meta,
  unnamed: { first: text, second: text, third: text },
  modifiedDate: 'phone',
  modifiedPerson: { id: text },
  followUp: { reminder: text },
  permissions: { useChat: text, startChat: text },
  information: {
    imageUrl: 'token',
    imageAnnotation: text,
    groupHomepageUrl: 'token',
    groupStatusId: text,
    groupTypeId: text,
    dateOfFoundation: 'phone',
    endDate: 'phone',
    meetingTime: text,
    weekday: text,
    groupCategoryId: text,
    ageGroupIds: [text],
    targetGroupId: text,
    maxMembers: text,
    note: text,
    campusId: text,
    chatStatus: text,
    color: text,
    signUpOverrideRoleId: text,
  },
  settings: {
    isHidden: text,
    isOpenForMembers: text,
    signUpOpeningDate: 'phone',
    signUpClosingDate: 'phone',
    signUpHeadline: text,
    signUpNotificationSentDate: 'phone',
    signUpOverrideRoleId: text,
    allowSpouseRegistration: text,
    allowChildRegistration: text,
    allowSameEmailRegistration: text,
    allowOtherRegistration: text,
    signUpEmailRequiredForAll: text,
    emailVerificationMode: text,
    sendDefaultSignUpMail: text,
    autoAccept: text,
    allowWaitinglist: text,
    waitinglistMaxPersons: text,
    automaticMoveUp: text,
    isPublic: text,
    visibility: text,
    inStatistic: text,
    groupMeeting: { autoCreate: text, templateId: text },
    qrCodeCheckin: text,
    qrCodeCheckinAutomaticEmail: text,
    chatHistoryVisible: text,
    informLeader: text,
    newMember: { campusId: text, statusId: text, departmentId: text },
    postsEnabled: text,
    defaultPostVisibility: text,
    defaultPostCommentsActive: text,
    defaultPostPlaceholderText: text,
    defaultPostNotificationScope: text,
    externalPostSubscriptionsEnabled: text,
    showStreet: text,
    appointmentId: text,
    appointmentStartDate: 'phone',
    maxMembers: text,
    statusesCountedTowardsSeats: [text],
  },
  roles: [
    {
      id: text,
      groupTypeId: text,
      name: text,
      nameTranslated: text,
      shorty: text,
      sortKey: text,
      type: text,
      isDefault: text,
      isHidden: text,
      growPathId: text,
      isLeader: text,
      groupTypeRoleId: text,
      forceTwoFactorAuth: text,
      isActive: text,
      canReadChat: text,
      canWriteChat: text,
      receiveQRCode: text,
      countsTowardsSeats: text,
      htmlTemplateIds: text,
    },
  ],
};

// `meta` of a list. The client reads none of it, so its counts hold
// canaries as well.
const listMeta: Shape = {
  count: 'phone',
  all: 'phone',
  pagination: {
    total: 'phone',
    limit: 'phone',
    current: 'phone',
    lastPage: 'phone',
  },
};

/** The body of a list answer and the canaries planted in it. */
export interface HighestLevelList {
  /** The answer as JSON text, ready for an interceptor. */
  readonly body: string;
  /** One canary for each field outside the list, the same in every entry. */
  readonly canaries: readonly Canary[];
}

/**
 * Gives each path in a shape one canary, made once and kept in the map. For
 * the fixtures of this package only.
 *
 * @param shape - The shape.
 * @param path - The path of the shape, the key of its canaries.
 * @param made - The canaries made so far.
 * @returns The planted value.
 */
export const plant = (
  shape: Shape,
  path: string,
  made: Map<string, Canary>,
): unknown => {
  if (typeof shape === 'string') {
    let canary = made.get(path);
    if (canary === undefined) {
      canary = makeCanary(shape);
      made.set(path, canary);
    }
    return canary.value;
  }
  if (Array.isArray(shape)) {
    return [plant((shape as readonly [Shape])[0], `${path}[]`, made)];
  }
  return Object.fromEntries(
    Object.entries(shape).map(([field, inner]) => [
      field,
      plant(inner, `${path}.${field}`, made),
    ]),
  );
};

const list = (
  hits: readonly object[],
  shape: Readonly<Record<string, Shape>>,
): HighestLevelList => {
  const made = new Map<string, Canary>();
  const data = hits.map((hit) => ({
    ...(plant(shape, 'entry', made) as Record<string, unknown>),
    ...hit,
  }));
  const body = JSON.stringify({ data, meta: plant(listMeta, 'meta', made) });
  return Object.freeze({ body, canaries: Object.freeze([...made.values()]) });
};

/**
 * Builds an answer of `GET /api/persons` at the highest security level of
 * persons: each entry with all 62 fields, ID and names from the hits given,
 * every other field a canary.
 *
 * @param hits - ID, first and last name of each entry, in order.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = personsAtHighestLevel([{ id: 1, firstName: 'Person', lastName: 'A' }]);
 * double.intercept({ path, method: 'GET' }).reply(200, answer.body, json);
 * assertNoCanary(result, answer.canaries, 'result');
 * ```
 */
export function personsAtHighestLevel(
  hits: readonly PersonHit[],
): HighestLevelList {
  return list(hits, personShape);
}

/**
 * Builds an answer of `GET /api/groups` at the highest security level of
 * groups: each entry with all 13 fields at the top and their nested ones,
 * ID and name from the hits given, every other field a canary.
 *
 * @param hits - ID and name of each entry, in order.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = groupsAtHighestLevel([{ id: 1, name: 'Gruppe A' }]);
 * ```
 */
export function groupsAtHighestLevel(
  hits: readonly GroupHit[],
): HighestLevelList {
  return list(hits, groupShape);
}

/**
 * Drops fields from an object shape, so that a kept field holds no canary
 * that the value of the test would hide. For the fixtures of this package
 * only.
 *
 * @param shape - The shape.
 * @param fields - The fields to drop.
 * @returns The shape without them.
 */
export const drop = (
  shape: Readonly<Record<string, Shape>>,
  ...fields: readonly string[]
): Readonly<Record<string, Shape>> =>
  Object.fromEntries(
    Object.entries(shape).filter(([field]) => !fields.includes(field)),
  );

// The fields of a person but the four a single read passes on.
const singlePersonShape = drop(personShape, 'isArchived');

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Puts the values of the test over a planted object, also in nested
 * objects, so that a kept field takes the value of the test and its
 * siblings keep their canaries. For the fixtures of this package only.
 *
 * @param planted - The planted object.
 * @param kept - The values of the test.
 * @returns The object with them.
 */
export const over = (planted: unknown, kept: unknown): unknown => {
  if (!isObject(planted) || !isObject(kept)) return kept;
  const result: Record<string, unknown> = { ...planted };
  for (const [field, value] of Object.entries(kept)) {
    result[field] = Object.hasOwn(planted, field)
      ? over(planted[field], value)
      : value;
  }
  return result;
};

// A group and a person as a membership names them, with the fields
// `08-persons-groups-read` described (`docs/research/churchtools-api.md`,
// F34). The person also as an assignment to a service names it (F37).
const groupReference: Readonly<Record<string, Shape>> = {
  title: text,
  domainType: text,
  domainIdentifier: text,
  apiUrl: 'token',
  frontendUrl: 'token',
  imageUrl: 'token',
  icon: text,
  color: { key: text, shade: text },
  initials: text,
  domainAttributes: {
    note: text,
    groupStatusId: text,
    groupTypeId: text,
    campusId: text,
    visibility: text,
    guid: 'token',
  },
  infos: [text],
};

/** The attributes of a person as a reference names them, for this package. */
export const personAttributes: Readonly<Record<string, Shape>> = {
  firstName: text,
  lastName: text,
  guid: 'token',
  dateOfDeath: 'phone',
  isArchived: text,
};

/** A person as a membership or an assignment names it, for this package. */
export const personReference: Readonly<Record<string, Shape>> = {
  title: text,
  domainType: text,
  domainIdentifier: text,
  apiUrl: 'token',
  frontendUrl: 'token',
  imageUrl: 'token',
  icon: text,
  color: text,
  initials: text,
  domainAttributes: personAttributes,
  infos: [text],
};

// One membership, as the members of a group and the groups of a person
// list it, with the fields of the person a request with `personFields[]`
// would add and the key the probe could not name.
const membershipShape: Readonly<Record<string, Shape>> = {
  id: text,
  personId: text,
  group: groupReference,
  person: personReference,
  groupTypeRoleId: text,
  roleChangedDate: 'phone',
  groupMemberStatus: text,
  statusChangedDate: 'phone',
  memberStartDate: 'phone',
  registeredBy: text,
  waitinglistPosition: text,
  comment: text,
  unnamed: { first: text },
  fields: [text],
  personFields: [{ email: 'email', mobile: 'phone', birthday: 'phone' }],
};

const personGroupShape: Readonly<Record<string, Shape>> = {
  ...drop(membershipShape, 'group', 'groupTypeRoleId', 'groupMemberStatus'),
  group: drop(groupReference, 'title', 'domainIdentifier'),
};

const memberShape: Readonly<Record<string, Shape>> = {
  ...drop(
    membershipShape,
    'personId',
    'person',
    'groupTypeRoleId',
    'groupMemberStatus',
  ),
  person: {
    ...drop(personReference, 'domainAttributes'),
    domainAttributes: drop(personAttributes, 'firstName', 'lastName'),
  },
};

// The six details of the lowest security level of groups a read passes on.
const groupDetailFields = [
  'meetingTime',
  'note',
  'maxMembers',
  'targetGroupId',
  'dateOfFoundation',
  'endDate',
] as const;

const singleGroupShape: Readonly<Record<string, Shape>> = {
  ...groupShape,
  information: drop(
    groupShape.information as Readonly<Record<string, Shape>>,
    ...groupDetailFields,
  ),
};

/** The body of an answer of ChurchTools and the canaries planted in it. */
export interface HighestLevelAnswer {
  /** The answer as JSON text, ready for an interceptor. */
  readonly body: string;
  /** One canary for each field outside the kept ones. */
  readonly canaries: readonly Canary[];
}

/**
 * The body of an answer and its canaries. For the fixtures of this package
 * only.
 *
 * @param data - The value of `data`.
 * @param made - The canaries planted in it.
 * @param meta - The value of `meta`, left out when undefined.
 * @returns The answer, frozen.
 */
export const answer = (
  data: unknown,
  made: Map<string, Canary>,
  meta?: unknown,
): HighestLevelAnswer =>
  Object.freeze({
    body: JSON.stringify(meta === undefined ? { data } : { data, meta }),
    canaries: Object.freeze([...made.values()]),
  });

/**
 * Builds an answer of `GET /api/persons/{personId}` at the highest security
 * level of persons: all 62 fields, ID, names and `isArchived` from the
 * person given, every other field a canary.
 *
 * @param person - The four fields the read passes on.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = personAtHighestLevel({ id: 1, firstName: 'Person', lastName: 'A', isArchived: false });
 * ```
 */
export function personAtHighestLevel(person: Person): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  return answer(over(plant(singlePersonShape, 'person', made), person), made);
}

/** A group of a person as a test gives it to {@link personGroupsAtHighestLevel}. */
export interface PersonGroupFixture {
  /** The ID of the group, or the text ChurchTools sends in its place. */
  readonly groupId: number | string;
  /** Name of the group. */
  readonly groupName: string;
  /** The ID of the role. */
  readonly groupTypeRoleId: number;
  /** The status of the membership. */
  readonly groupMemberStatus: string;
}

/**
 * Builds an answer of `GET /api/persons/{personId}/groups`: each entry
 * with every field of a membership, the group with its ID in
 * `domainIdentifier` and its name in `title`, role and status from the
 * groups given, every other field a canary, also the count in `meta`.
 *
 * @param groups - The groups of the person, in order.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = personGroupsAtHighestLevel([
 *   { groupId: 3, groupName: 'Gruppe A', groupTypeRoleId: 8, groupMemberStatus: 'active' },
 * ]);
 * ```
 */
export function personGroupsAtHighestLevel(
  groups: readonly PersonGroupFixture[],
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const data = groups.map((group) =>
    over(plant(personGroupShape, 'entry', made), {
      group: {
        domainIdentifier:
          typeof group.groupId === 'number'
            ? String(group.groupId)
            : group.groupId,
        title: group.groupName,
      },
      groupTypeRoleId: group.groupTypeRoleId,
      groupMemberStatus: group.groupMemberStatus,
    }),
  );
  return answer(data, made, plant({ count: 'phone' }, 'meta', made));
}

/**
 * Builds an answer of `GET /api/groups/{groupId}` at the highest security
 * level of groups: all 13 fields at the top and their nested ones, ID,
 * name and the six details from the group given, every other field a
 * canary. Without details, the six fields are missing, as for an account
 * without the security level of groups.
 *
 * @param group - The fields the read passes on.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = groupAtHighestLevel({ id: 3, name: 'Gruppe A', details: null });
 * ```
 */
export function groupAtHighestLevel(group: Group): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const { details } = group;
  const kept =
    details === null
      ? { id: group.id, name: group.name }
      : {
          id: group.id,
          name: group.name,
          information: Object.fromEntries(
            groupDetailFields.map((field) => [field, details[field]]),
          ),
        };
  return answer(over(plant(singleGroupShape, 'group', made), kept), made);
}

/**
 * Builds one page of an answer of `GET /api/groups/{groupId}/members`:
 * each entry with every field of a membership, the person with names in
 * `domainAttributes`, ID, role and status from the members given, every
 * other field a canary. Of `meta`, only `pagination.lastPage` holds a
 * number.
 *
 * @param members - The members of the page, in order.
 * @param lastPage - The last page ChurchTools reports.
 * @returns The body and the canaries planted in it.
 * @example
 * ```ts
 * const answer = groupMembersAtHighestLevel([
 *   { personId: 1, firstName: 'Person', lastName: 'A', groupTypeRoleId: 8, groupMemberStatus: 'active' },
 * ], 1);
 * ```
 */
export function groupMembersAtHighestLevel(
  members: readonly GroupMember[],
  lastPage: number,
): HighestLevelAnswer {
  const made = new Map<string, Canary>();
  const data = members.map((member) =>
    over(plant(memberShape, 'entry', made), {
      personId: member.personId,
      person: {
        domainAttributes: {
          firstName: member.firstName,
          lastName: member.lastName,
        },
      },
      groupTypeRoleId: member.groupTypeRoleId,
      groupMemberStatus: member.groupMemberStatus,
    }),
  );
  const meta = over(
    plant(
      {
        count: 'phone',
        all: 'phone',
        pagination: { total: 'phone', limit: 'phone', current: 'phone' },
      },
      'meta',
      made,
    ),
    { pagination: { lastPage } },
  );
  return answer(data, made, meta);
}
