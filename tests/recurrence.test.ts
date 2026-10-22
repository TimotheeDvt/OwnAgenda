import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/ics/parse';
import { expandCalendar } from '../src/ics/recurrence';
import { fixture } from './helpers';

const range = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

function expand(file: string, start: string, end: string) {
  return expandCalendar(parseIcs(fixture(file)), 'file-1', range(start, end));
}

describe('expandCalendar: single event', () => {
  it('returns the event with its details', () => {
    const [event, ...rest] = expand('single-event.ics', '2025-03-01', '2025-04-01');
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      uid: 'single-1@test',
      calendarFileId: 'file-1',
      title: 'Project kickoff',
      location: 'Room 4',
      description: 'Bring the slides',
      allDay: false,
      recurring: false,
      startInput: '2025-03-10T14:00:00.000Z',
      endInput: '2025-03-10T15:30:00.000Z',
    });
    expect(event!.start.toISOString()).toBe('2025-03-10T14:00:00.000Z');
  });

  it('omits events outside the range', () => {
    expect(expand('single-event.ics', '2025-05-01', '2025-06-01')).toHaveLength(0);
  });
});

describe('expandCalendar: all-day events', () => {
  it('uses date-only inputs and an exclusive end date', () => {
    const events = expand('all-day.ics', '2025-04-01', '2025-05-01');
    const conf = events.find((e) => e.uid === 'allday-1@test');
    expect(conf).toMatchObject({ allDay: true, startInput: '2025-04-14', endInput: '2025-04-16' });
  });

  it('defaults a missing DTEND to one day', () => {
    const events = expand('all-day.ics', '2025-04-01', '2025-05-01');
    const holiday = events.find((e) => e.uid === 'allday-2@test');
    expect(holiday).toMatchObject({
      allDay: true,
      startInput: '2025-04-20',
      endInput: '2025-04-21',
    });
  });
});

describe('expandCalendar: weekly RRULE with EXDATE and override', () => {
  const events = expand('weekly-exdate.ics', '2025-01-01', '2025-03-01');
  const starts = events.map((e) => e.startInput).sort();

  it('expands COUNT occurrences minus the EXDATE', () => {
    expect(starts).toEqual([
      '2025-01-06T09:00:00.000Z',
      '2025-01-13T09:00:00.000Z',
      // 2025-01-20 is excluded by EXDATE
      '2025-01-27T11:00:00.000Z', // moved by the RECURRENCE-ID override
      '2025-02-03T09:00:00.000Z',
      '2025-02-10T09:00:00.000Z',
    ]);
  });

  it('applies the override title and marks all occurrences recurring with unique ids', () => {
    const moved = events.find((e) => e.startInput === '2025-01-27T11:00:00.000Z');
    expect(moved?.title).toBe('Team standup (moved)');
    expect(events.every((e) => e.recurring)).toBe(true);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it('only returns occurrences within the requested range', () => {
    const feb = expand('weekly-exdate.ics', '2025-02-01', '2025-02-08');
    expect(feb.map((e) => e.startInput)).toEqual(['2025-02-03T09:00:00.000Z']);
  });
});

describe('expandCalendar: VTIMEZONE', () => {
  it('converts zoned times to the correct UTC instants across a DST change', () => {
    const events = expand('vtimezone.ics', '2025-03-01', '2025-04-01');
    expect(events.map((e) => e.startInput).sort()).toEqual([
      '2025-03-05T15:00:00.000Z', // EST, UTC-5
      '2025-03-12T14:00:00.000Z', // EDT, UTC-4 (DST started 2025-03-09)
      '2025-03-19T14:00:00.000Z',
    ]);
  });
});

describe('expandCalendar: TZID without VTIMEZONE and floating times', () => {
  const events = expand('missing-vtimezone.ics', '2025-06-25', '2025-07-10');

  it('falls back to Intl for IANA TZIDs that have no VTIMEZONE', () => {
    const paris = events.find((e) => e.uid === 'novtz-1@test');
    expect(paris?.startInput).toBe('2025-07-01T08:00:00.000Z'); // CEST, UTC+2
  });

  it('keeps floating times as local wall-clock inputs', () => {
    const floating = events.find((e) => e.uid === 'floating-1@test');
    expect(floating?.startInput).toBe('2025-07-02T08:00:00');
    expect(floating?.endInput).toBe('2025-07-02T09:00:00');
  });
});

describe('expandCalendar: safety', () => {
  it('stops iterating unbounded rules after the range end', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:daily@test',
      'DTSTART:20200101T080000Z',
      'DTEND:20200101T083000Z',
      'RRULE:FREQ=DAILY',
      'SUMMARY:Daily',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = expandCalendar(parseIcs(ics), 'f', range('2025-01-01', '2025-01-08'));
    expect(events).toHaveLength(7);
  });
});
