import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import {
  createEvent,
  EventNotFoundError,
  findMasterEvent,
  moveEvent,
  removeEvent,
  updateEvent,
  type EventDraft,
} from '../src/ics/edit';
import { parseIcs } from '../src/ics/parse';
import { expandCalendar } from '../src/ics/recurrence';
import { serializeCalendar } from '../src/ics/serialize';
import { fixture } from './helpers';

const NOW = new Date('2025-06-01T12:00:00Z');
const PARIS = 'Europe/Paris';

const range = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });

/** Serializes and parses again, as a save + reload would. */
const roundTrip = (vcal: ICAL.Component) => parseIcs(serializeCalendar(vcal));

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    title: 'Dentist',
    allDay: false,
    start: '2025-06-10T09:00:00.000Z',
    end: '2025-06-10T10:00:00.000Z',
    ...overrides,
  };
}

describe('serializeCalendar round-trip', () => {
  it.each(['single-event.ics', 'all-day.ics', 'weekly-exdate.ics', 'vtimezone.ics'])(
    '%s: parse → serialize → parse yields an equivalent calendar',
    (name) => {
      const original = parseIcs(fixture(name));
      const text = serializeCalendar(original);
      expect(text).toMatch(/\r\n$/);
      expect(parseIcs(text).toJSON()).toEqual(original.toJSON());
    },
  );
});

describe('createEvent', () => {
  it('adds a timed event in UTC with UID, DTSTAMP and SEQUENCE', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    const uid = createEvent(vcal, draft({ location: 'Clinic' }), PARIS, NOW, 'new-1');
    const text = serializeCalendar(vcal);
    expect(text).toContain('UID:new-1');
    expect(text).toContain('DTSTART:20250610T090000Z');
    expect(text).toContain('DTEND:20250610T100000Z');
    expect(text).toContain('DTSTAMP:20250601T120000Z');
    expect(text).toContain('SEQUENCE:0');
    expect(text).toContain('LOCATION:Clinic');
    expect(text).not.toContain('DESCRIPTION:\r\n');

    const [event] = expandCalendar(roundTrip(vcal), 'f', range('2025-06-10', '2025-06-11'));
    expect(event).toMatchObject({ uid, title: 'Dentist', location: 'Clinic' });
  });

  it('generates a UUID when none is given', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    expect(createEvent(vcal, draft(), PARIS)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes all-day events as DATE values', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    createEvent(
      vcal,
      draft({ allDay: true, start: '2025-06-10', end: '2025-06-12' }),
      PARIS,
      NOW,
      'ad',
    );
    const text = serializeCalendar(vcal);
    expect(text).toContain('DTSTART;VALUE=DATE:20250610');
    expect(text).toContain('DTEND;VALUE=DATE:20250612');
  });

  it('uses the display timezone when the file has its VTIMEZONE', () => {
    const vcal = parseIcs(fixture('vtimezone.ics'));
    createEvent(
      vcal,
      draft({ start: '2025-07-01T14:00:00Z', end: '2025-07-01T15:00:00Z' }),
      'America/New_York',
      NOW,
      'ny',
    );
    const text = serializeCalendar(vcal);
    expect(text).toContain('DTSTART;TZID=America/New_York:20250701T100000');
    const event = expandCalendar(roundTrip(vcal), 'f', range('2025-07-01', '2025-07-02')).find(
      (e) => e.uid === 'ny',
    );
    expect(event?.startInput).toBe('2025-07-01T14:00:00.000Z');
  });
});

describe('updateEvent', () => {
  it('updates fields in place and keeps unknown properties and alarms', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    updateEvent(
      vcal,
      'single-1@test',
      draft({ title: 'Kickoff (moved)', description: '' }),
      PARIS,
      NOW,
    );
    const text = serializeCalendar(vcal);
    expect(text).toContain('SUMMARY:Kickoff (moved)');
    expect(text).toContain('DTSTART:20250610T090000Z');
    expect(text).not.toContain('LOCATION');
    expect(text).not.toContain('Bring the slides');
    expect(text).toContain('X-CUSTOM-PROP:keep me');
    expect(text).toContain('BEGIN:VALARM');
    expect(text).toContain('SEQUENCE:1');
    expect(text).toContain('LAST-MODIFIED:20250601T120000Z');
  });

  it('keeps the TZID of zoned events and converts the instant into that zone', () => {
    const vcal = parseIcs(fixture('vtimezone.ics'));
    // tz-1 is recurring, but updateEvent itself only writes DTSTART/DTEND.
    updateEvent(
      vcal,
      'tz-1@test',
      draft({ start: '2025-03-05T16:00:00Z', end: '2025-03-05T17:00:00Z' }),
      PARIS,
      NOW,
    );
    expect(serializeCalendar(vcal)).toContain('DTSTART;TZID=America/New_York:20250305T110000');
  });

  it('keeps a TZID that has no VTIMEZONE, computing the wall time with Intl', () => {
    const vcal = parseIcs(fixture('missing-vtimezone.ics'));
    updateEvent(
      vcal,
      'novtz-1@test',
      draft({ start: '2025-07-01T10:00:00Z', end: '2025-07-01T11:00:00Z' }),
      'UTC',
      NOW,
    );
    expect(serializeCalendar(vcal)).toContain('DTSTART;TZID=Europe/Paris:20250701T120000');
  });

  it('writes floating events as wall-clock time in the display timezone', () => {
    const vcal = parseIcs(fixture('missing-vtimezone.ics'));
    updateEvent(
      vcal,
      'floating-1@test',
      draft({ start: '2025-07-02T07:00:00Z', end: '2025-07-02T08:00:00Z' }),
      PARIS,
      NOW,
    );
    expect(serializeCalendar(vcal)).toContain('DTSTART:20250702T090000\r\n');
  });

  it('switches between all-day and timed', () => {
    const vcal = parseIcs(fixture('all-day.ics'));
    updateEvent(vcal, 'allday-2@test', draft(), PARIS, NOW);
    let text = serializeCalendar(vcal);
    expect(text).toContain('DTSTART:20250610T090000Z');
    expect(text).not.toContain('DTSTART;VALUE=DATE:20250420');

    updateEvent(
      vcal,
      'allday-2@test',
      draft({ allDay: true, start: '2025-06-10', end: '2025-06-11' }),
      PARIS,
      NOW,
    );
    text = serializeCalendar(vcal);
    expect(text).toContain('DTSTART;VALUE=DATE:20250610');
    expect(text).toContain('DTEND;VALUE=DATE:20250611');
  });

  it('replaces DURATION with DTEND', () => {
    const vcal = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:dur',
        'DTSTART:20250101T100000Z',
        'DURATION:PT2H',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    updateEvent(vcal, 'dur', draft(), PARIS, NOW);
    const text = serializeCalendar(vcal);
    expect(text).not.toContain('DURATION');
    expect(text).toContain('DTEND:20250610T100000Z');
  });

  it('throws for an unknown UID', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    expect(() => updateEvent(vcal, 'nope', draft(), PARIS)).toThrow(EventNotFoundError);
  });
});

describe('removeEvent', () => {
  it('removes the event and its overrides', () => {
    const vcal = parseIcs(fixture('weekly-exdate.ics'));
    expect(removeEvent(vcal, 'weekly-1@test')).toHaveLength(2);
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(0);
    expect(() => removeEvent(vcal, 'weekly-1@test')).toThrow(EventNotFoundError);
  });
});

describe('moveEvent', () => {
  it('moves the event and copies the VTIMEZONE it needs', () => {
    const source = parseIcs(fixture('vtimezone.ics'));
    const target = parseIcs(fixture('all-day.ics'));
    moveEvent(
      source,
      target,
      'tz-1@test',
      draft({ title: 'Moved', start: '2025-03-05T16:00:00Z', end: '2025-03-05T17:00:00Z' }),
      PARIS,
      NOW,
    );
    expect(findMasterEvent(source, 'tz-1@test')).toBeNull();
    const text = serializeCalendar(target);
    expect(text).toContain('BEGIN:VTIMEZONE');
    expect(text).toContain('TZID:America/New_York');
    expect(text).toContain('SUMMARY:Moved');
  });
});
