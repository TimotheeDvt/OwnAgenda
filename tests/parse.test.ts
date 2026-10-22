import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { calendarDisplayName, IcsParseError, parseIcs, toCalendarFile } from '../src/ics/parse';
import { fixture } from './helpers';

describe('parseIcs', () => {
  it('returns the VCALENDAR component', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    expect(vcal.name).toBe('vcalendar');
    expect(vcal.getAllSubcomponents('vevent')).toHaveLength(1);
  });

  it('keeps properties and components the app does not use', () => {
    const vcal = parseIcs(fixture('single-event.ics'));
    const vevent = vcal.getFirstSubcomponent('vevent')!;
    expect(vevent.getFirstPropertyValue('x-custom-prop')).toBe('keep me');
    expect(vevent.getFirstSubcomponent('valarm')).not.toBeNull();
    expect(vcal.toString()).toContain('X-CUSTOM-PROP:keep me');
  });

  it('registers VTIMEZONE components with the timezone service', () => {
    parseIcs(fixture('vtimezone.ics'));
    expect(ICAL.TimezoneService.has('America/New_York')).toBe(true);
  });

  it('throws IcsParseError on invalid data', () => {
    expect(() => parseIcs('this is not a calendar')).toThrow(IcsParseError);
  });

  it('throws when the root is not a VCALENDAR', () => {
    expect(() => parseIcs('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Someone\r\nEND:VCARD\r\n')).toThrow(
      IcsParseError,
    );
  });
});

describe('calendarDisplayName', () => {
  it('prefers X-WR-CALNAME', () => {
    expect(calendarDisplayName(parseIcs(fixture('single-event.ics')), 'work.ics')).toBe('Work');
  });

  it('falls back to the file name without extension', () => {
    expect(calendarDisplayName(parseIcs(fixture('all-day.ics')), 'Holidays.ICS')).toBe('Holidays');
  });
});

describe('toCalendarFile', () => {
  it('builds a clean CalendarFile', () => {
    const file = toCalendarFile(
      { id: 'abc', name: 'work.ics', modifiedTime: '2025-01-01T00:00:00.000Z' },
      fixture('single-event.ics'),
    );
    expect(file).toMatchObject({
      fileId: 'abc',
      name: 'work.ics',
      displayName: 'Work',
      modifiedTime: '2025-01-01T00:00:00.000Z',
      dirty: false,
    });
  });
});
