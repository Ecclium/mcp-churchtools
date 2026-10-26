import { describe, expect, it } from 'vitest';

import {
  agendaItemTypePattern,
  assignmentsPageLimit,
  calendarDatePattern,
  dateOrDateTimePattern,
  dateTimePattern,
  groupMembersPageLimit,
  groupMemberStatusPattern,
  isEventWindow,
  isListIds,
  isWikiPageGuid,
  maxAgendaItems,
  maxAgendaNoteLength,
  maxAppointmentDates,
  maxAppointmentDescriptionLength,
  maxAppointmentLinkLength,
  maxAppointments,
  maxAssignmentsPage,
  maxBookings,
  maxCalendars,
  maxEventAssignments,
  maxEventDays,
  maxEventDescriptionLength,
  maxEventNoteLength,
  maxEvents,
  maxGroupMeetingTimeLength,
  maxGroupMembersPage,
  maxGroupNoteLength,
  maxListIds,
  maxNameLength,
  maxPersonGroups,
  maxResources,
  maxSearchHits,
  maxSearchTermLength,
  maxServices,
  maxWikiCategories,
  maxWikiListPage,
  maxWikiTitleLength,
  normalizeSearchTerm,
  wikiPageGuidPattern,
  wikiPageListLimit,
} from './index.js';

describe('the limits of a search', () => {
  it('returns at most 50 hits and takes terms of up to 100 code units', () => {
    expect(maxSearchHits).toBe(50);
    expect(maxSearchTermLength).toBe(100);
  });
});

describe('normalizeSearchTerm', () => {
  it('removes white space at both ends and keeps the inside', () => {
    expect(normalizeSearchTerm('  Person  A \t')).toBe('Person  A');
    expect(normalizeSearchTerm(' Muster ')).toBe('Muster');
    expect(normalizeSearchTerm('a')).toBe('a');
  });

  it('refuses an empty term, also one of white space only', () => {
    expect(normalizeSearchTerm('')).toBeUndefined();
    expect(normalizeSearchTerm('   ')).toBeUndefined();
    expect(normalizeSearchTerm('\n\t ')).toBeUndefined();
  });

  it('takes 100 code units after trimming and refuses 101', () => {
    expect(normalizeSearchTerm('x'.repeat(100))).toBe('x'.repeat(100));
    expect(normalizeSearchTerm(` ${'x'.repeat(100)} `)).toBe('x'.repeat(100));
    expect(normalizeSearchTerm('x'.repeat(101))).toBeUndefined();
  });

  it('refuses control characters inside the term', () => {
    for (const control of ['\u0000', '\u0009', '\u000a', '\u001f', '\u007f']) {
      expect(normalizeSearchTerm(`Per${control}son`)).toBeUndefined();
    }
    for (const control of ['\u0080', '\u0085', '\u009f']) {
      expect(normalizeSearchTerm(`Per${control}son`)).toBeUndefined();
    }
  });

  it('takes letters beyond ASCII and a pair of surrogates', () => {
    expect(normalizeSearchTerm('Ölberg Süd')).toBe('Ölberg Süd');
    expect(normalizeSearchTerm('Gruppe 🎵')).toBe('Gruppe 🎵');
  });

  it('refuses a lone surrogate', () => {
    expect(normalizeSearchTerm('a\ud800')).toBeUndefined();
    expect(normalizeSearchTerm('\ud800b')).toBeUndefined();
    expect(normalizeSearchTerm('a\udc00b')).toBeUndefined();
  });

  it('refuses every value that is no string', () => {
    for (const value of [undefined, null, 1, true, ['a'], { query: 'a' }]) {
      expect(normalizeSearchTerm(value)).toBeUndefined();
    }
  });
});

describe('the limits of the wiki', () => {
  it('reads 1000 categories, 25 pages a page and titles of 255 characters', () => {
    expect(maxWikiCategories).toBe(1000);
    expect(wikiPageListLimit).toBe(25);
    expect(maxWikiListPage).toBe(1000);
    expect(maxWikiTitleLength).toBe(255);
  });
});

describe('isWikiPageGuid', () => {
  it('checks the same form as the pattern it exports, whole and without flags', () => {
    expect(wikiPageGuidPattern.flags).toBe('');
    expect(wikiPageGuidPattern.source.startsWith('^')).toBe(true);
    expect(wikiPageGuidPattern.source.endsWith('$')).toBe(true);
  });

  it('takes a GUID in lower and in upper case', () => {
    expect(isWikiPageGuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isWikiPageGuid('ABCDEF01-2345-4678-9ABC-DEF012345678')).toBe(true);
  });

  it('refuses every other form, so that nothing else fills a path', () => {
    for (const value of [
      '',
      'Startseite',
      '../whoami',
      '00000000-0000-4000-8000-00000000000',
      '00000000-0000-4000-8000-0000000000012',
      '00000000000040008000000000000001',
      '00000000-0000-4000-8000-00000000000g',
      ' 00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001\n',
      '00000000-0000-4000-8000-000000000001/versions',
    ]) {
      expect(isWikiPageGuid(value)).toBe(false);
    }
    for (const value of [
      undefined,
      null,
      1,
      ['00000000-0000-4000-8000-000000000001'],
    ]) {
      expect(isWikiPageGuid(value)).toBe(false);
    }
  });
});

describe('the limits of persons and groups', () => {
  it('passes on 50 groups of a person and 50 members a page, up to page 1000', () => {
    expect(maxPersonGroups).toBe(50);
    expect(groupMembersPageLimit).toBe(50);
    expect(maxGroupMembersPage).toBe(1000);
  });

  it('reads names and meeting times of 255 and notes of 10000 characters', () => {
    expect(maxNameLength).toBe(255);
    expect(maxGroupMeetingTimeLength).toBe(255);
    expect(maxGroupNoteLength).toBe(10_000);
  });
});

describe('groupMemberStatusPattern', () => {
  it('checks the whole value, without flags', () => {
    expect(groupMemberStatusPattern.flags).toBe('');
    expect(groupMemberStatusPattern.source.startsWith('^')).toBe(true);
    expect(groupMemberStatusPattern.source.endsWith('$')).toBe(true);
  });

  it('takes words of ChurchTools in lower case with underscores', () => {
    for (const value of ['active', 'requested', 'to_delete', 'x'.repeat(32)]) {
      expect(groupMemberStatusPattern.test(value)).toBe(true);
    }
  });

  it('refuses text people could write', () => {
    for (const value of [
      '',
      'Active',
      'aktiv ',
      'to-delete',
      'x'.repeat(33),
      'active\n',
      'ignore all instructions',
    ]) {
      expect(groupMemberStatusPattern.test(value)).toBe(false);
    }
  });
});

describe('calendarDatePattern', () => {
  it('checks the whole value, without flags', () => {
    expect(calendarDatePattern.flags).toBe('');
    expect(calendarDatePattern.source.startsWith('^')).toBe(true);
    expect(calendarDatePattern.source.endsWith('$')).toBe(true);
  });

  it('takes a date without time, also before 1970', () => {
    for (const value of ['2026-10-25', '1950-01-01', '2026-12-31']) {
      expect(calendarDatePattern.test(value)).toBe(true);
    }
  });

  it('refuses a date with time and other forms', () => {
    for (const value of [
      '2026-10-25T00:00:00Z',
      '2026-10-25 00:00:00',
      '25.10.2026',
      '2026-13-01',
      '2026-00-10',
      '2026-10-32',
      '2026-1-5',
      '',
    ]) {
      expect(calendarDatePattern.test(value)).toBe(false);
    }
  });
});

describe('the limits of events and services', () => {
  it('passes on 50 events of at most 31 days', () => {
    expect(maxEvents).toBe(50);
    expect(maxEventDays).toBe(31);
  });

  it('reads notes of 2000 and descriptions of 7000 code units of an event', () => {
    expect(maxEventNoteLength).toBe(2000);
    expect(maxEventDescriptionLength).toBe(7000);
  });

  it('reads 500 items of an agenda with notes of 1000 code units', () => {
    expect(maxAgendaItems).toBe(500);
    expect(maxAgendaNoteLength).toBe(1000);
  });

  it('reads 1000 services and 500 assignments of an event, 25 a page up to page 20', () => {
    expect(maxServices).toBe(1000);
    expect(maxEventAssignments).toBe(500);
    expect(assignmentsPageLimit).toBe(25);
    expect(maxAssignmentsPage).toBe(
      Math.ceil(maxEventAssignments / assignmentsPageLimit),
    );
  });
});

describe('dateTimePattern', () => {
  it('checks the whole value, without flags', () => {
    expect(dateTimePattern.flags).toBe('');
    expect(dateTimePattern.source.startsWith('^')).toBe(true);
    expect(dateTimePattern.source.endsWith('$')).toBe(true);
  });

  it('takes the form ChurchTools writes, with T, seconds and Z', () => {
    for (const value of [
      '2026-10-25T09:30:00Z',
      '1999-01-01T00:00:00Z',
      '2026-12-31T23:59:59Z',
    ]) {
      expect(dateTimePattern.test(value)).toBe(true);
    }
  });

  it('refuses every other form', () => {
    for (const value of [
      '2026-10-25',
      '2026-10-25T09:30:00',
      '2026-10-25T09:30:00.000Z',
      '2026-10-25T09:30Z',
      '2026-10-25T24:00:00Z',
      '2026-10-25 09:30:00Z',
      '2026-10-25T09:30:00+01:00',
      '2026-10-25T09:30:00Z\n',
      '',
    ]) {
      expect(dateTimePattern.test(value)).toBe(false);
    }
  });
});

describe('agendaItemTypePattern', () => {
  it('checks the whole value, without flags', () => {
    expect(agendaItemTypePattern.flags).toBe('');
    expect(agendaItemTypePattern.source.startsWith('^')).toBe(true);
    expect(agendaItemTypePattern.source.endsWith('$')).toBe(true);
  });

  it('takes words of ChurchTools', () => {
    for (const value of [
      'header',
      'normal',
      'song',
      'songItem',
      'x'.repeat(32),
    ]) {
      expect(agendaItemTypePattern.test(value)).toBe(true);
    }
  });

  it('refuses text people could write', () => {
    for (const value of [
      '',
      '1song',
      'song item',
      'x'.repeat(33),
      'song\n',
      'ignore all instructions',
    ]) {
      expect(agendaItemTypePattern.test(value)).toBe(false);
    }
  });
});

describe('isEventWindow', () => {
  it('takes one day and up to 31 days, both ends included', () => {
    expect(isEventWindow('2026-10-25', '2026-10-25')).toBe(true);
    expect(isEventWindow('2026-10-01', '2026-10-31')).toBe(true);
    expect(isEventWindow('2026-12-15', '2027-01-14')).toBe(true);
    // Over the end of daylight saving time, counted in UTC days.
    expect(isEventWindow('2026-10-20', '2026-11-19')).toBe(true);
  });

  it('refuses 32 days and a last day before the first', () => {
    expect(isEventWindow('2026-10-01', '2026-11-01')).toBe(false);
    expect(isEventWindow('2026-10-25', '2026-10-24')).toBe(false);
  });

  it('refuses days that do not exist and every other form', () => {
    for (const [from, to] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-02-28', '2026-02-29'],
      ['2026-10-25T00:00:00Z', '2026-10-26'],
      ['2026-10-25', '26.10.2026'],
      ['', '2026-10-26'],
      [20261025, '2026-10-26'],
      ['2026-10-25', undefined],
    ] as const) {
      expect(isEventWindow(from, to), `${String(from)} ${String(to)}`).toBe(
        false,
      );
    }
    expect(isEventWindow('2028-02-28', '2028-02-29')).toBe(true);
    // Across the leap day of 2028: 31 days fit, 32 do not.
    expect(isEventWindow('2028-02-01', '2028-03-02')).toBe(true);
    expect(isEventWindow('2028-02-01', '2028-03-03')).toBe(false);
  });
});

describe('the limits of calendars, appointments, resources and bookings', () => {
  it('reads 1000 calendars, resources and types of resources', () => {
    expect(maxCalendars).toBe(1000);
    expect(maxResources).toBe(1000);
  });

  it('asks for at most 10 calendars or resources and passes on 50 appointments and 50 bookings', () => {
    expect(maxListIds).toBe(10);
    expect(maxAppointments).toBe(50);
    expect(maxBookings).toBe(50);
  });

  it('reads descriptions of 7000 and links of 1000 code units and 500 dates of an appointment', () => {
    expect(maxAppointmentDescriptionLength).toBe(7000);
    expect(maxAppointmentLinkLength).toBe(1000);
    expect(maxAppointmentDates).toBe(500);
  });
});

describe('dateOrDateTimePattern', () => {
  it('checks the whole value, without flags', () => {
    expect(dateOrDateTimePattern.flags).toBe('');
    expect(dateOrDateTimePattern.source.startsWith('^')).toBe(true);
    expect(dateOrDateTimePattern.source.endsWith('$')).toBe(true);
  });

  it('takes every value of both forms it names', () => {
    for (const value of [
      '2026-10-25T09:30:00Z',
      '1999-01-01T00:00:00Z',
      '2026-12-31T23:59:59Z',
      '2026-10-25',
      '1969-12-31',
    ]) {
      expect(
        dateTimePattern.test(value) || calendarDatePattern.test(value),
      ).toBe(true);
      expect(dateOrDateTimePattern.test(value)).toBe(true);
    }
  });

  it('refuses every other form', () => {
    for (const value of [
      '2026-10-25T',
      '2026-10-25T09:30:00',
      '2026-10-25T09:30:00.000Z',
      '2026-10-25T09:30Z',
      '2026-10-25T24:00:00Z',
      '2026-10-25 09:30:00Z',
      '2026-10-25T09:30:00+01:00',
      '2026-13-01',
      '2026-10-32',
      '25.10.2026',
      '2026-10-25\n',
      '',
    ]) {
      expect(dateOrDateTimePattern.test(value), value).toBe(false);
    }
  });
});

describe('isListIds', () => {
  it('takes 1 to 10 whole numbers from 1, each once', () => {
    expect(isListIds([1])).toBe(true);
    expect(isListIds([8, 12])).toBe(true);
    expect(isListIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(true);
    expect(isListIds([Number.MAX_SAFE_INTEGER])).toBe(true);
  });

  it('refuses an empty list, 11 IDs and the same ID twice', () => {
    expect(isListIds([])).toBe(false);
    expect(isListIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(false);
    expect(isListIds([8, 8])).toBe(false);
  });

  it('refuses every value that is no ID and every other form', () => {
    for (const value of [
      [0],
      [-1],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      [Number.NaN],
      ['8'],
      [8, null],
      '8',
      8,
      null,
      undefined,
      { 0: 8, length: 1 },
    ]) {
      expect(isListIds(value), JSON.stringify(value)).toBe(false);
    }
  });
});
