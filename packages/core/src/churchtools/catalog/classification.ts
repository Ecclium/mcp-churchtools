/**
 * The classification of every GET operation of the generated part by hand
 * (ADR 0067). An operation is either allowed, with the sensitivity of its
 * answer, or excluded, with the reason. Allowed are the areas of Ecclium
 * and the rights, with the master data under the prefix of an area;
 * everything else is excluded. A test fails while an operation of the
 * generated part has no entry here, and the client refuses it until then.
 *
 * Where the OpenAPI document names the kind of a path parameter wrongly or
 * not at all, the entry gives it: a whole number, or the GUID of a wiki
 * page.
 *
 * @packageDocumentation
 */
import { allowed, type Classification, excluded } from './types.js';

/** The classification by hand, keyed by `operationId`. */
export const classification: Readonly<Record<string, Classification>> =
  Object.freeze({
    // Allowed: Persons and their relations. special: persons reveal
    // religious affiliation (ADR 0060, ADR 0064).
    // Without the filters by birthday, which would reveal the day the mask
    // cuts to the year.
    'get-persons': allowed('special', undefined, [
      'birthday_after',
      'birthday_before',
    ]),
    'get-persons-relationships': allowed('special'),
    'get-persons-id': allowed('special'),
    'get-persons-id-events': allowed('special'),
    'get-persons-id-events-id-services': allowed('special'),
    'get-persons-id-groups': allowed('special'),
    'get-persons-personId-relationships': allowed('special'),
    'get-persons-id-servicerequests': allowed('special'),
    'get-persons-id-servicerequests-id': allowed('special'),

    // Allowed: Groups and their members, meetings and statistics.
    // special, like persons.
    'get-groups': allowed('special'),
    'get-groups-grouped': allowed('special'),
    'get-groups-hierarchies': allowed('special'),
    'get-groups-ids': allowed('special'),
    'get-groups-members': allowed('special'),
    'get-groups-groupId': allowed('special'),
    'get-groups-groupId-children': allowed('special'),
    'get-groups-id-meetings': allowed('special'),
    'get-groups-groupId-meetings-meetingId': allowed('special'),
    'get-groups-groupId-meetings-meetingId-members': allowed('special'),
    'get-groups-groupId-memberids': allowed('special'),
    'get-groups-groupId-memberpreview': allowed('special'),
    'get-groups-id-members': allowed('special'),
    'get-groups-groupId-members-statistics': allowed('special'),
    'get-groups-groupId-members-personId': allowed('special'),
    'get-groups-groupId-members-personId-meetings': allowed('special'),
    'get-groups-groupId-parents': allowed('special', { groupId: 'integer' }),
    'get-groups-id-roles': allowed('special', { groupId: 'integer' }),
    'get-groups-id-statistics': allowed('special'),
    'get-groups-id-wiki-categories-pages': allowed('special'),

    // Allowed: Master data of persons and groups, which explain IDs in
    // their answers.
    'get-group-agegroups': allowed('none'),
    'get-group-agegroups-ageGroupId': allowed('none'),
    'get-group-groupcategories': allowed('none'),
    'get-group-groupcategories-groupCategoryId': allowed('none'),
    'get-group-grouptypes': allowed('none'),
    'get-group-grouptypes-groupTypeId': allowed('none'),
    'get-group-meetingtemplates': allowed('none'),
    'get-group-meetingtemplates-meetingTemplateId': allowed('none'),
    'get-group-memberstatus': allowed('none'),
    'get-group-roles': allowed('none'),
    'get-group-roles-roleId': allowed('none'),
    'get-group-targetgroups': allowed('none'),
    'get-group-targetgroups-targetGroupId': allowed('none'),
    'get-person-masterdata': allowed('none'),
    'get-person-relationshiptypes': allowed('none'),
    'get-person-relationshiptypes-id': allowed('none'),
    'get-person-sexes': allowed('none'),
    'get-person-sexes-id': allowed('none'),

    // Allowed: Rights of the account, of groups and of persons. special:
    // they name persons.
    'get-permissions-assignment-targets': allowed('special'),
    'get-permissions-definitions': allowed('special'),
    'get-permissions-global': allowed('special'),
    'get-permissions-global-auths-authId-assignment-summary':
      allowed('special'),
    'get-permissions-global-auths-authId-persons': allowed('special'),
    'get-permissions-global-person-summary': allowed('special'),
    'get-permissions-internal-events-eventId': allowed('special'),
    'get-permissions-internal-groups': allowed('special'),
    'get-permissions-internal-groups-groupId': allowed('special'),
    'get-permissions-internal-groups-groupId-auths-authId-persons':
      allowed('special'),
    'get-permissions-internal-persons-id': allowed('special'),
    'get-permissions-locked': allowed('special'),
    'get-permissions-origins-global-persons-personId': allowed('special'),
    'get-permissions-origins-internal-persons-personId': allowed('special'),
    'get-permissions-permissionDomainType': allowed('special'),
    'get-permissions-permissionDomainType-permissionDomainId':
      allowed('special'),

    // Allowed: The account and the global search. The search finds
    // persons and groups.
    'get-search': allowed('special'),
    'get-whoami': allowed('personal'),

    // Allowed: Events, their agendas, facts and the persons a service
    // may take, with their master data and templates.
    'get-agendatemplates': allowed('none'),
    'get-agendatemplates-agendaId': allowed('none'),
    'get-event-masterdata': allowed('none'),
    'get-events': allowed('personal'),
    'get-events-facts': allowed('personal'),
    'get-events-id': allowed('personal'),
    'get-events-id-agenda': allowed('personal'),
    'get-events-id-agenda-songs': allowed('personal'),
    'get-events-eventId-facts': allowed('personal'),
    'get-events-eventId-facts-factId': allowed('personal'),
    'get-events-eventId-services-serviceId-possiblepersons': allowed('special'),
    'get-events-id-possiblepersonsforservice': allowed('special'),
    'get-eventtemplates': allowed('none'),

    // Allowed: Services and service groups.
    'get-servicegroups': allowed('none'),
    'get-servicegroups-id': allowed('none'),
    'get-services': allowed('none'),
    'get-services-id': allowed('none'),

    // Allowed: Calendars and appointments.
    'get-calendars': allowed('none'),
    'get-calendars-appointments': allowed('personal'),
    'get-calendars-appointments-templates': allowed('personal'),
    'get-calendars-appointments-templates-id': allowed('personal'),
    'get-calendars-appointments-appointmentId-startDate': allowed('personal'),
    'get-calendars-calendarId': allowed('none'),
    'get-calendars-calendarId-appointments': allowed('personal'),
    'get-calendars-calendarId-appointments-appointmentId': allowed('personal'),
    'get-calendars-calendarId-appointments-appointmentId-startDate':
      allowed('personal'),

    // Allowed: Resources, their types and master data, and bookings.
    'get-bookings': allowed('personal'),
    'get-bookings-id': allowed('personal'),
    'get-resource-masterdata': allowed('none'),
    'get-resources': allowed('none'),
    'get-resources-resourceId': allowed('none'),
    'get-resources-resourceId-statistics': allowed('none'),
    'get-resourcetypes': allowed('none'),
    'get-resourcetypes-resourceTypeId': allowed('none'),

    // Allowed: The wiki.
    'get-wiki-categories': allowed('personal'),
    'get-wiki-categories-id-pages': allowed('personal'),
    'get-wiki-categories-id-pages-identifier': allowed('personal', {
      identifier: 'guid',
    }),
    'get-wiki-categories-id-pages-identifier-versions': allowed('personal', {
      identifier: 'guid',
    }),
    'get-wiki-categories-id-pages-id-versions-id': allowed('personal', {
      identifier: 'guid',
    }),
    'get-wiki-pages': allowed('personal'),
    'get-wiki-search': allowed('personal'),

    // Allowed: Songs, their arrangements, categories and sources.
    'get-song-categories': allowed('none'),
    'get-song-categories-id': allowed('none'),
    'get-song-sources': allowed('none'),
    'get-song-sources-id': allowed('none'),
    'get-songs': allowed('none'),
    'get-songs-songId': allowed('none'),
    'get-songs-songId-arrangements': allowed('none'),
    'get-songs-songId-arrangements-arrangementId': allowed('none'),

    // Excluded, secret: Tokens, sign-in, secrets and codes that open
    // something, such as the login token of a person or the hash of a
    // public page.
    'get-captcha': excluded('secret'),
    'get-externallogins': excluded('secret'),
    'get-externallogins-id': excluded('secret'),
    'get-externallogins-id-oidc-start': excluded('secret'),
    'get-externallogins-id-oidc-test-state': excluded('secret'),
    'get-externallogins-id-saml-test-state': excluded('secret'),
    'get-grouphomepages': excluded('secret'),
    'get-grouphomepages-hash': excluded('secret'),
    'get-groups-groupId-grouphomepage': excluded('secret'),
    'get-groups-id-qrcodecheckin': excluded('secret'),
    'get-groups-id-qrcodecheckin-personId': excluded('secret'),
    'get-groups-id-qrcodecheckin-personId-pdf': excluded('secret'),
    'get-oauthclients': excluded('secret'),
    'get-persons-personId-devices': excluded('secret'),
    'get-persons-personId-devices-deviceId': excluded('secret'),
    'get-persons-id-external-logins': excluded('secret'),
    'get-persons-id-loginstring': excluded('secret'),
    'get-persons-id-logintoken': excluded('secret'),
    'get-persons-id-settings-twofactor': excluded('secret'),
    'get-persons-id-settings-twofactor-force': excluded('secret'),
    'get-publicgroups-id-hash': excluded('secret'),
    'get-sso-logins': excluded('secret'),

    // Excluded, csrf: The CSRF token.
    'get-csrftoken': excluded('csrf'),

    // Excluded, file: Files, documents and data sheets, also those an
    // operation generates.
    'get-files-domainType': excluded('file'),
    'get-files-domainType-domainIdentifier': excluded('file'),
    'get-files-id-meta': excluded('file'),
    'get-finance-transactions-nextdocumentnumber': excluded('file'),
    'get-groups-groupId-documenttemplates': excluded('file'),
    'get-persons-personId-information': excluded('file'),

    // Excluded, finance: Finances.
    'get-finance-accountclasses': excluded('finance'),
    'get-finance-accountclasses-id': excluded('finance'),
    'get-finance-accountgroups': excluded('finance'),
    'get-finance-accountgroups-id': excluded('finance'),
    'get-finance-accountingperiods': excluded('finance'),
    'get-finance-accountingperiods-id': excluded('finance'),
    'get-finance-accountingperiods-id-accounts-statements': excluded('finance'),
    'get-finance-accountingperiods-id-accounts-id-movements':
      excluded('finance'),
    'get-finance-accountingperiods-id-accounts-id-statements':
      excluded('finance'),
    'get-finance-accountingperiods-id-accounts-id-statements-id-movements':
      excluded('finance'),
    'get-finance-accountingperiods-id-bills': excluded('finance'),
    'get-finance-accountingperiods-id-userrules': excluded('finance'),
    'get-finance-accounts': excluded('finance'),
    'get-finance-accounts-id': excluded('finance'),
    'get-finance-accounttypes': excluded('finance'),
    'get-finance-accounttypes-id': excluded('finance'),
    'get-finance-bills-id': excluded('finance'),
    'get-finance-cashdiscounts': excluded('finance'),
    'get-finance-cashdiscounts-id': excluded('finance'),
    'get-finance-clients': excluded('finance'),
    'get-finance-clients-id': excluded('finance'),
    'get-finance-costcenters': excluded('finance'),
    'get-finance-costcenters-id': excluded('finance'),
    'get-finance-donators': excluded('finance'),
    'get-finance-donators-receipts': excluded('finance'),
    'get-finance-donators-donatorCoupleId': excluded('finance'),
    'get-finance-eubp-health': excluded('finance'),
    'get-finance-eubp-submissions': excluded('finance'),
    'get-finance-eubp-submissions-id': excluded('finance'),
    'get-finance-eubp-submissions-id-accounts': excluded('finance'),
    'get-finance-eubp-submissions-id-preview': excluded('finance'),
    'get-finance-masterdata': excluded('finance'),
    'get-finance-splittransactions-id': excluded('finance'),
    'get-finance-taxrates': excluded('finance'),
    'get-finance-taxrates-id': excluded('finance'),
    'get-finance-taxtypes': excluded('finance'),
    'get-finance-taxtypes-id': excluded('finance'),
    'get-finance-templates': excluded('finance'),
    'get-finance-templates-export': excluded('finance'),
    'get-finance-transactionpurposes': excluded('finance'),
    'get-finance-transactionpurposes-id': excluded('finance'),
    'get-finance-transactions': excluded('finance'),
    'get-finance-transactions-ids': excluded('finance'),
    'get-finance-transactions-summary': excluded('finance'),
    'get-finance-transactions-id': excluded('finance'),

    // Excluded, log: Logs and histories.
    'get-groups-groupId-members-history': excluded('log'),
    'get-history': excluded('log'),
    'get-joblog': excluded('log'),
    'get-logs': excluded('log'),
    'get-logs-statistics-login': excluded('log'),
    'get-logs-id': excluded('log'),
    'get-sync-logs': excluded('log'),

    // Excluded, export: Exports.
    'get-events-ical': excluded('export'),
    'get-htmltemplates-templateId-export': excluded('export'),

    // Excluded, system: Settings of the system and of persons,
    // integrations, templates and jobs.
    'get-bulkletters': excluded('system'),
    'get-bulkletters-id': excluded('system'),
    'get-bulkletters-id-persons': excluded('system'),
    'get-config': excluded('system'),
    'get-dbfieldtypes': excluded('system'),
    'get-domainobjects': excluded('system'),
    'get-evangelischetermine-eventtypes': excluded('system'),
    'get-groups-groupId-members-routines': excluded('system'),
    'get-groups-groupId-newsletter-integrations': excluded('system'),
    'get-htmltemplates': excluded('system'),
    'get-htmltemplates-templateId': excluded('system'),
    'get-htmltemplates-templateId-html': excluded('system'),
    'get-htmltemplates-templateId-mjml': excluded('system'),
    'get-info': excluded('system'),
    'get-jobs': excluded('system'),
    'get-languages': excluded('system'),
    'get-newsletter-integrations': excluded('system'),
    'get-persons-id-settings': excluded('system'),
    'get-persons-id-settings-module': excluded('system'),
    'get-persons-id-settings-module-attribute': excluded('system'),
    'get-placeholders-email': excluded('system'),
    'get-placeholders-group-id': excluded('system'),
    'get-pollfornews': excluded('system'),
    'get-pr-masterdata': excluded('system'),
    'get-printers': excluded('system'),
    'get-profiles': excluded('system'),
    'get-profiles-church': excluded('system'),
    'get-queues-queue-jobgroups-jobGroup': excluded('system'),
    'get-registrationconfig-id': excluded('system'),
    'get-routines': excluded('system'),
    'get-routines-routineId': excluded('system'),
    'get-routines-routineId-runs': excluded('system'),
    'get-securitylevels': excluded('system'),
    'get-startpage': excluded('system'),
    'get-sync-adapters': excluded('system'),
    'get-sync-adapters-id': excluded('system'),
    'get-sync-conflicts': excluded('system'),
    'get-sync-conflicts-id': excluded('system'),
    'get-sync-entitymappings': excluded('system'),
    'get-sync-entitymappings-id': excluded('system'),
    'get-sync-executions': excluded('system'),
    'get-sync-externalsystems': excluded('system'),
    'get-sync-externalsystems-externalSystemId': excluded('system'),
    'get-sync-externalsystems-externalSystemId-fieldmappings':
      excluded('system'),
    'get-sync-externalsystems-id-fieldmappings-domaintype': excluded('system'),
    'get-sync-externalsystems-id-fieldmappings-domaintype-nosuggestions':
      excluded('system'),
    'get-sync-externalsystems-id-jobconfigs': excluded('system'),
    'get-sync-externalsystems-externalSystemId-jobconfigs-jobId':
      excluded('system'),
    'get-sync-externalsystems-externalSystemId-jobconfigs-jobId-executions-executionId':
      excluded('system'),
    'get-sync-externalsystems-externalSystemId-jobconfigs-jobId-filter':
      excluded('system'),
    'get-sync-externalsystems-externalSystemId-jobconfigs-jobId-properties':
      excluded('system'),
    'get-sync-jobconfigs': excluded('system'),
    'get-translations': excluded('system'),
    'get-translations-keysbytext': excluded('system'),
    'get-website-data': excluded('system'),
    'get-widgets-blog': excluded('system'),
    'get-widgets-rss': excluded('system'),

    // Excluded, care: Pastoral care and health: follow-ups, notes,
    // absences with their reasons and growth paths.
    'get-followups': excluded('care'),
    'get-followups-followUpId': excluded('care'),
    'get-groups-absences': excluded('care'),
    'get-groups-groupId-followups': excluded('care'),
    'get-groups-groupId-followups-statistics': excluded('care'),
    'get-groups-groupId-members-personId-followups': excluded('care'),
    'get-groups-id-members-id-followups-statistics': excluded('care'),
    'get-notes': excluded('care'),
    'get-person-growpaths': excluded('care'),
    'get-person-growpaths-id': excluded('care'),
    'get-persons-personId-absences': excluded('care'),
    'get-persons-personId-absences-id': excluded('care'),
    'get-persons-personId-followups': excluded('care'),
    'get-persons-personId-followups-statistics': excluded('care'),

    // Excluded, communication: Posts, comments, reactions, chat, meeting
    // requests and exchange requests between persons.
    'get-calendars-calendarId-appointments-appointmentId-meetingrequests':
      excluded('communication'),
    'get-calendars-calendarId-meetingrequest-candidates':
      excluded('communication'),
    'get-chat': excluded('communication'),
    'get-externalposts': excluded('communication'),
    'get-externalposts-instances-guid-channels-guid-posts-guid':
      excluded('communication'),
    'get-groups-groupId-posts': excluded('communication'),
    'get-groups-groupId-poststatistics': excluded('communication'),
    'get-persons-id-events-id-services-id-exchangerequests':
      excluded('communication'),
    'get-persons-id-events-id-services-id-exchangerequests-candidates':
      excluded('communication'),
    'get-persons-id-exchangerequests': excluded('communication'),
    'get-persons-personId-openmeetingrequests': excluded('communication'),
    'get-persons-personId-posts': excluded('communication'),
    'get-persons-personId-poststatistics': excluded('communication'),
    'get-post-groups': excluded('communication'),
    'get-post-hidden': excluded('communication'),
    'get-post-linkings': excluded('communication'),
    'get-post-reports': excluded('communication'),
    'get-post-search': excluded('communication'),
    'get-posts': excluded('communication'),
    'get-posts-postId': excluded('communication'),
    'get-posts-postId-comments': excluded('communication'),
    'get-posts-postId-comments-commentId-reactions': excluded('communication'),
    'get-posts-postId-reactions': excluded('communication'),

    // Excluded, scope: Outside the areas of Ecclium: master data across
    // areas, administration such as duplicates and the rules of dynamic
    // groups, public sign-up pages and subscriptions.
    'get-addresses-search': excluded('scope'),
    'get-addresses-domainType-domainIdentifier': excluded('scope'),
    'get-campuses': excluded('scope'),
    'get-campuses-id': excluded('scope'),
    'get-contactlabels': excluded('scope'),
    'get-contactlabels-id': excluded('scope'),
    'get-dbfields': excluded('scope'),
    'get-dbfields-fieldId': excluded('scope'),
    'get-dbfields-fieldId-options': excluded('scope'),
    'get-dbfields-fieldId-options-metadata': excluded('scope'),
    'get-departments': excluded('scope'),
    'get-dynamicgroups': excluded('scope'),
    'get-dynamicgroups-id-ruleset': excluded('scope'),
    'get-dynamicgroups-id-status': excluded('scope'),
    'get-facts': excluded('scope'),
    'get-facts-id': excluded('scope'),
    'get-furtherlinks': excluded('scope'),
    'get-furtherlinks-furtherLinkId': excluded('scope'),
    'get-groups-groupId-memberfields': excluded('scope'),
    'get-groups-optins': excluded('scope'),
    'get-person-commentviewers': excluded('scope'),
    'get-person-commentviewers-id': excluded('scope'),
    'get-persons-duplicates': excluded('scope'),
    'get-persons-personid-merge-duplicateid': excluded('scope'),
    'get-persons-id-privacypolicy': excluded('scope'),
    'get-publicgroups-id': excluded('scope'),
    'get-publicgroups-groupId-form': excluded('scope'),
    'get-publicgroups-groupId-possiblerequesters': excluded('scope'),
    'get-publicgroups-id-signoutdata': excluded('scope'),
    'get-repeatcalculation': excluded('scope'),
    'get-statuses': excluded('scope'),
    'get-statuses-id': excluded('scope'),
    'get-subscriptions-personId': excluded('scope'),
    'get-subscriptions-personId-subject': excluded('scope'),
    'get-subscriptions-personId-subject-subjectIdentifier': excluded('scope'),
    'get-tags-domainType': excluded('scope'),
    'get-tags-domainType-domainId': excluded('scope'),
    'get-tags-tagId': excluded('scope'),

    // Excluded, media: An answer that is not JSON: CSV, tables, HTML,
    // iCalendar, images or nothing.
    'get-calendars-calendarId-appointments-appointmentId-ical':
      excluded('media'),
    'get-churchquery-metadata': excluded('media'),
    'get-externallogins-oidc-callback': excluded('media'),
    'get-externallogins-id-oidc-callback': excluded('media'),
    'get-externallogins-externalLoginId-saml-login': excluded('media'),
    'get-externallogins-externalLoginId-saml-metadata': excluded('media'),
    'get-externallogins-externalLoginId-saml-sls': excluded('media'),
    'get-finance-accounts-csv': excluded('media'),
    'get-finance-accounts-export': excluded('media'),
    'get-finance-costcenters-export': excluded('media'),
    'get-finance-transactions-datevexport': excluded('media'),
    'get-finance-transactions-documentnumberavailable': excluded('media'),
    'get-finance-transactions-export': excluded('media'),
    'get-groups-groupId-documents-htmlTemplateId': excluded('media'),
    'get-groups-groupId-meetings-export': excluded('media'),
    'get-groups-groupId-members-export': excluded('media'),
    'get-groups-id-members-id-documents-id': excluded('media'),
    'get-images-fileId-hash': excluded('media'),
    'get-images-fileId-hash-queryParams': excluded('media'),
    'get-license-fetch': excluded('media'),
    'get-profiles-slugcheck-slug': excluded('media'),
    'get-publicgroups-signup-confirm-confirmationToken': excluded('media'),
    'get-saml-login': excluded('media'),
    'get-saml-metadata': excluded('media'),
    'get-securitylevels-id': excluded('media'),
    'get-sync-adapters-proxy': excluded('media'),
    'get-sync-externalsystems-externalSystemId-adapterproxy-uri':
      excluded('media'),
    'get-website-starttest': excluded('media'),

    // Excluded, birthdate: Lists of birthdays, which reveal the day and
    // month the mask cuts to the year.
    'get-persons-birthdays': excluded('birthdate'),

    // Excluded, deprecated: Marked as deprecated in the OpenAPI document.
    'get-calendars-calendarId-meetingrequestpersons': excluded('deprecated'),
    'get-fields': excluded('deprecated'),
    'get-files-id-metadata': excluded('deprecated'),
    'get-finance-transactions-csv': excluded('deprecated'),
    'get-masterdata-person': excluded('deprecated'),
    'get-persons-search_old': excluded('deprecated'),
  });
