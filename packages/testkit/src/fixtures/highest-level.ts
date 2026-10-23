/**
 * Answers of the lists of persons and groups in the form an account with
 * the highest security levels gets them, for the tests of the search tools
 * (ADR 0060). Every field a search does not pass on holds a canary, so a
 * test can show that no layer lets one of them through. The fields kept,
 * ID and name, take the values the test gives.
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
import type { GroupHit, PersonHit } from '@ecclium/mcp-churchtools-plugin-api';

import { type Canary, type CanaryKind, makeCanary } from '../canary.js';

// A leaf holds a canary of its kind; an object holds fields; a list holds
// one element of its shape.
type Shape =
  CanaryKind | { readonly [field: string]: Shape } | readonly [Shape];

const text: CanaryKind = 'name';

const meta: Shape = {
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

// Gives each path in a shape one canary, made once and kept in the map.
const plant = (
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
