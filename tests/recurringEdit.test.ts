import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { createEvent, type EventDraft } from '../src/ics/edit';
import { parseIcs } from '../src/ics/parse';
import { expandCalendar } from '../src/ics/recurrence';
import {
  deleteFollowing,
  deleteOccurrence,
  editFollowing,
  editOccurrence,
  editSeries,
  seriesRule,
  type OccurrenceRef,
} from '../src/ics/recurringEdit';
import {
  describeRule,
  recurFromSimpleRule,
  simpleRuleFromRecur,
  type SimpleRule,
} from '../src/ics/rrule';
import { serializeCalendar } from '../src/ics/serialize';
import { fixture } from './helpers';

const NOW = new Date('2025-06-01T12:00:00Z');
const UTC = 'UTC';
const UID = 'weekly-1@test';

const range = { start: new Date('2024-12-01'), end: new Date('2025-12-31') };

/** Serializes and parses again (like save + reload), then lists occurrences sorted by start. */
function occurrences(vcal: ICAL.Component) {
  return expandCalendar(parseIcs(serializeCalendar(vcal)), 'f', range).sort((a, b) =>
    a.startInput.localeCompare(b.startInput),
  );
}

const starts = (vcal: ICAL.Component) => occurrences(vcal).map((e) => e.startInput);

/** Ref to the weekly fixture's occurrence originally at `iso` (UTC, 30 min). */
function ref(iso: string, displayed = iso): OccurrenceRef {
  const end = new Date(Date.parse(displayed) + 30 * 60_000).toISOString();
  return {
    uid: UID,
    recurrenceId: ICAL.Time.fromJSDate(new Date(iso), true),
    original: { allDay: false, start: displayed, end },
  };
}

function draftFor(r: OccurrenceRef, overrides: Partial<EventDraft> = {}): EventDraft {
  return { title: 'Team standup', ...r.original, ...overrides };
}

const weekly = () => parseIcs(fixture('weekly-exdate.ics'));

describe('rrule conversion', () => {
  it('reads simple rules and rejects unsupported parts', () => {
    const rule = simpleRuleFromRecur(
      ICAL.Recur.fromString('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;COUNT=5'),
      UTC,
    );
    expect(rule).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      byDay: ['MO', 'WE'],
      end: { type: 'count', count: 5 },
    });
    expect(simpleRuleFromRecur(ICAL.Recur.fromString('FREQ=MONTHLY;BYDAY=2TU'), UTC)).toBeNull();
  });

  it('writes UNTIL as a date for all-day series and as UTC end-of-day otherwise', () => {
    const rule: SimpleRule = {
      freq: 'DAILY',
      interval: 1,
      byDay: [],
      end: { type: 'until', date: '2025-03-10' },
    };
    const date = ICAL.Time.fromDateString('2025-03-01');
    expect(recurFromSimpleRule(rule, date, null, UTC).toString()).toBe('FREQ=DAILY;UNTIL=20250310');
    const zoned = ICAL.Time.fromJSDate(new Date('2025-03-01T09:00:00Z'), true);
    expect(recurFromSimpleRule(rule, zoned, null, 'Europe/Paris').toString()).toBe(
      'FREQ=DAILY;UNTIL=20250310T225959Z',
    );
  });

  it('describes rules', () => {
    expect(
      describeRule({
        freq: 'WEEKLY',
        interval: 2,
        byDay: ['MO'],
        end: { type: 'count', count: 3 },
      }),
    ).toBe('Every 2 weeks on Mon, 3 times');
  });

  it('reports the series rule of an event', () => {
    expect(seriesRule(weekly(), UID, UTC)).toEqual({
      rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'], end: { type: 'count', count: 6 } },
      custom: false,
    });
  });
});

describe('creating recurring events', () => {
  it('writes the RRULE relative to DTSTART', () => {
    const vcal = weekly();
    createEvent(
      vcal,
      {
        title: 'Gym',
        allDay: false,
        start: '2025-03-03T18:00:00Z',
        end: '2025-03-03T19:00:00Z',
        rrule: { freq: 'DAILY', interval: 2, byDay: [], end: { type: 'count', count: 3 } },
      },
      UTC,
      NOW,
      'gym',
    );
    const gym = occurrences(vcal).filter((e) => e.uid === 'gym');
    expect(gym.map((e) => e.startInput)).toEqual([
      '2025-03-03T18:00:00.000Z',
      '2025-03-05T18:00:00.000Z',
      '2025-03-07T18:00:00.000Z',
    ]);
    expect(gym.every((e) => e.recurring)).toBe(true);
  });
});

describe('this occurrence', () => {
  it('creates an override with RECURRENCE-ID and keeps the series', () => {
    const vcal = weekly();
    const r = ref('2025-02-03T09:00:00.000Z');
    editOccurrence(
      vcal,
      r,
      draftFor(r, {
        title: 'Standup (late)',
        start: '2025-02-03T15:00:00.000Z',
        end: '2025-02-03T15:30:00.000Z',
      }),
      UTC,
      NOW,
    );
    const text = serializeCalendar(vcal);
    expect(text).toContain('RECURRENCE-ID:20250203T090000Z');
    const events = occurrences(vcal);
    expect(events.map((e) => e.startInput)).toEqual([
      '2025-01-06T09:00:00.000Z',
      '2025-01-13T09:00:00.000Z',
      '2025-01-27T11:00:00.000Z',
      '2025-02-03T15:00:00.000Z',
      '2025-02-10T09:00:00.000Z',
    ]);
    expect(events.find((e) => e.startInput.startsWith('2025-02-03'))?.title).toBe('Standup (late)');
  });

  it('updates an existing override instead of adding another', () => {
    const vcal = weekly();
    // The fixture already overrides 2025-01-27 (moved to 11:00).
    const r = ref('2025-01-27T09:00:00.000Z', '2025-01-27T11:00:00.000Z');
    editOccurrence(vcal, r, draftFor(r, { title: 'Renamed' }), UTC, NOW);
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(2);
    expect(occurrences(vcal).find((e) => e.title === 'Renamed')?.startInput).toBe(
      '2025-01-27T11:00:00.000Z',
    );
  });

  it('deletes one occurrence with an EXDATE', () => {
    const vcal = weekly();
    deleteOccurrence(vcal, ref('2025-02-03T09:00:00.000Z'), NOW);
    expect(starts(vcal)).not.toContain('2025-02-03T09:00:00.000Z');
    expect(starts(vcal)).toHaveLength(4);
  });

  it('deleting an overridden occurrence removes the override too', () => {
    const vcal = weekly();
    deleteOccurrence(vcal, ref('2025-01-27T09:00:00.000Z', '2025-01-27T11:00:00.000Z'), NOW);
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(1);
    expect(starts(vcal)).toHaveLength(4);
  });
});

describe('all events', () => {
  it('moves the series by the same amount, with its EXDATEs and overrides', () => {
    const vcal = weekly();
    const r = ref('2025-01-13T09:00:00.000Z');
    // Move the occurrence one hour later; the whole series follows.
    editSeries(
      vcal,
      r,
      draftFor(r, { start: '2025-01-13T10:00:00.000Z', end: '2025-01-13T10:45:00.000Z' }),
      UTC,
      NOW,
    );
    const events = occurrences(vcal);
    expect(events.map((e) => e.startInput)).toEqual([
      '2025-01-06T10:00:00.000Z',
      '2025-01-13T10:00:00.000Z',
      // 2025-01-20 stays excluded (EXDATE moved too)
      '2025-01-27T11:00:00.000Z', // override kept, its RECURRENCE-ID moved to 10:00
      '2025-02-03T10:00:00.000Z',
      '2025-02-10T10:00:00.000Z',
    ]);
    expect(events[0]?.endInput).toBe('2025-01-06T10:45:00.000Z');
  });

  it('renames the series and overrides that had the old title', () => {
    const vcal = weekly();
    // Give the override the series title, so it should follow the rename.
    const r = ref('2025-01-27T09:00:00.000Z', '2025-01-27T11:00:00.000Z');
    editOccurrence(vcal, r, draftFor(r), UTC, NOW);
    const first = ref('2025-01-06T09:00:00.000Z');
    editSeries(vcal, first, draftFor(first, { title: 'Daily sync' }), UTC, NOW);
    expect(new Set(occurrences(vcal).map((e) => e.title))).toEqual(new Set(['Daily sync']));
  });

  it('drops exceptions when the rule changes', () => {
    const vcal = weekly();
    const r = ref('2025-01-06T09:00:00.000Z');
    editSeries(
      vcal,
      r,
      draftFor(r, {
        rrule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'], end: { type: 'count', count: 3 } },
      }),
      UTC,
      NOW,
    );
    expect(starts(vcal)).toEqual([
      '2025-01-06T09:00:00.000Z',
      '2025-01-13T09:00:00.000Z',
      '2025-01-20T09:00:00.000Z',
    ]);
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(1);
  });
});

describe('this and following', () => {
  it('splits the series with UNTIL and continues the remaining COUNT', () => {
    const vcal = weekly();
    const r = ref('2025-02-03T09:00:00.000Z');
    const newUid = editFollowing(
      vcal,
      r,
      draftFor(r, {
        title: 'New standup',
        start: '2025-02-03T08:00:00.000Z',
        end: '2025-02-03T08:30:00.000Z',
      }),
      UTC,
      NOW,
      'new-series',
    );
    expect(newUid).toBe('new-series');
    expect(serializeCalendar(vcal)).toContain('UNTIL=20250203T085959Z');

    const events = occurrences(vcal);
    expect(events.map((e) => [e.uid, e.startInput])).toEqual([
      [UID, '2025-01-06T09:00:00.000Z'],
      [UID, '2025-01-13T09:00:00.000Z'],
      [UID, '2025-01-27T11:00:00.000Z'],
      // COUNT=6 had 4 occurrences before the split (EXDATE included): 2 remain.
      ['new-series', '2025-02-03T08:00:00.000Z'],
      ['new-series', '2025-02-10T08:00:00.000Z'],
    ]);
    expect(events.at(-1)?.title).toBe('New standup');
  });

  it('moves later overrides to the new series', () => {
    const vcal = weekly();
    const r = ref('2025-01-13T09:00:00.000Z');
    editFollowing(vcal, r, draftFor(r, { title: 'Renamed' }), UTC, NOW, 'new-series');
    const moved = occurrences(vcal).find((e) => e.startInput === '2025-01-27T11:00:00.000Z');
    expect(moved?.uid).toBe('new-series');
    expect(starts(vcal)).not.toContain('2025-01-20T09:00:00.000Z'); // EXDATE moved too
  });

  it('on the first occurrence, edits the whole series', () => {
    const vcal = weekly();
    const r = ref('2025-01-06T09:00:00.000Z');
    expect(editFollowing(vcal, r, draftFor(r, { title: 'All' }), UTC, NOW)).toBe(UID);
    expect(
      vcal.getAllSubcomponents('vevent').filter((v) => !v.hasProperty('recurrence-id')),
    ).toHaveLength(1);
  });

  it('deletes this and following occurrences', () => {
    const vcal = weekly();
    deleteFollowing(vcal, ref('2025-01-27T09:00:00.000Z', '2025-01-27T11:00:00.000Z'), NOW);
    expect(starts(vcal)).toEqual(['2025-01-06T09:00:00.000Z', '2025-01-13T09:00:00.000Z']);
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(1);
  });

  it('deleting from the first occurrence removes the series', () => {
    const vcal = weekly();
    deleteFollowing(vcal, ref('2025-01-06T09:00:00.000Z'), NOW);
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(0);
  });
});

describe('zoned and all-day series', () => {
  it('splits a TZID series with a UTC UNTIL and keeps the TZID on the new series', () => {
    const vcal = parseIcs(fixture('vtimezone.ics'));
    const rid = ICAL.Time.fromDateTimeString('2025-03-12T10:00:00');
    rid.zone = ICAL.TimezoneService.get('America/New_York')!;
    const r: OccurrenceRef = {
      uid: 'tz-1@test',
      recurrenceId: rid,
      original: {
        allDay: false,
        start: '2025-03-12T14:00:00.000Z',
        end: '2025-03-12T15:00:00.000Z',
      },
    };
    editFollowing(vcal, r, { title: 'Later', ...r.original }, UTC, NOW, 'ny-2');
    const text = serializeCalendar(vcal);
    expect(text).toContain('UNTIL=20250312T135959Z');
    expect(text).toMatch(/UID:ny-2[\s\S]*DTSTART;TZID=America\/New_York:20250312T100000/);
    expect(occurrences(vcal).map((e) => e.startInput)).toEqual([
      '2025-03-05T15:00:00.000Z',
      '2025-03-12T14:00:00.000Z',
      '2025-03-19T14:00:00.000Z',
    ]);
  });

  it('handles all-day series', () => {
    const vcal = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:bins',
        'DTSTART;VALUE=DATE:20250101',
        'DTEND;VALUE=DATE:20250102',
        'RRULE:FREQ=DAILY;COUNT=5',
        'SUMMARY:Bins',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    const r: OccurrenceRef = {
      uid: 'bins',
      recurrenceId: ICAL.Time.fromDateString('2025-01-03'),
      original: { allDay: true, start: '2025-01-03', end: '2025-01-04' },
    };
    deleteOccurrence(vcal, r, NOW);
    expect(serializeCalendar(vcal)).toContain('EXDATE;VALUE=DATE:20250103');
    deleteFollowing(vcal, { ...r, recurrenceId: ICAL.Time.fromDateString('2025-01-04') }, NOW);
    expect(serializeCalendar(vcal)).toContain('UNTIL=20250103');
    expect(occurrences(vcal).map((e) => e.startInput)).toEqual(['2025-01-01', '2025-01-02']);

    const first: OccurrenceRef = {
      ...r,
      recurrenceId: ICAL.Time.fromDateString('2025-01-01'),
      original: { allDay: true, start: '2025-01-01', end: '2025-01-02' },
    };
    editSeries(
      vcal,
      first,
      { title: 'Bins', allDay: true, start: '2025-01-02', end: '2025-01-03' },
      UTC,
      NOW,
    );
    expect(occurrences(vcal).map((e) => e.startInput)).toEqual(['2025-01-02', '2025-01-03']);
  });
});
