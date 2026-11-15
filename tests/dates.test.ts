import { describe, expect, it } from 'vitest';
import {
  addDays,
  eventInputToIso,
  formatStartsIn,
  instantToWall,
  isoWeek,
  normalizeTime,
  wallToInstant,
} from '../src/util/dates';

describe('date helpers', () => {
  it('computes ISO week numbers, including around the new year', () => {
    expect(isoWeek('2026-10-19')).toBe(43);
    expect(isoWeek('2026-10-25')).toBe(43);
    expect(isoWeek('2026-10-26')).toBe(44);
    expect(isoWeek('2021-01-03')).toBe(53);
    expect(isoWeek('2024-12-30')).toBe(1);
    expect(isoWeek('2026-12-31')).toBe(53);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('parses 24-hour times typed by the user', () => {
    expect(normalizeTime('09:30')).toBe('09:30');
    expect(normalizeTime('9:30')).toBe('09:30');
    expect(normalizeTime('930')).toBe('09:30');
    expect(normalizeTime('1830')).toBe('18:30');
    expect(normalizeTime('18')).toBe('18:00');
    expect(normalizeTime('18.15')).toBe('18:15');
    expect(normalizeTime(' 0:05 ')).toBe('00:05');
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('12:60')).toBeNull();
    expect(normalizeTime('9 pm')).toBeNull();
    expect(normalizeTime('')).toBeNull();
  });

  it('converts instants to wall-clock inputs and back', () => {
    const ms = Date.UTC(2025, 6, 1, 8, 30);
    expect(instantToWall(ms, 'Europe/Paris')).toEqual({ date: '2025-07-01', time: '10:30' });
    expect(wallToInstant('2025-07-01', '10:30', 'Europe/Paris')).toBe(ms);
    expect(wallToInstant('2025-07-01', '', 'Europe/Paris')).toBeNaN();
  });

  it('treats floating event inputs as wall time in the display zone', () => {
    expect(eventInputToIso('2025-07-02T08:00:00', 'Europe/Paris')).toBe('2025-07-02T06:00:00.000Z');
    expect(eventInputToIso('2025-07-02T08:00:00.000Z', 'Europe/Paris')).toBe(
      '2025-07-02T08:00:00.000Z',
    );
  });

  describe('formatStartsIn', () => {
    const at = (iso: string) => Date.parse(iso);
    const now = at('2026-11-15T10:00:00Z');

    it('counts minutes within the hour, rounding up', () => {
      expect(formatStartsIn(at('2026-11-15T10:25:00Z'), now, 'UTC')).toBe('in 25 min');
      expect(formatStartsIn(at('2026-11-15T10:00:20Z'), now, 'UTC')).toBe('in 1 min');
      expect(formatStartsIn(at('2026-11-15T10:59:00Z'), now, 'UTC')).toBe('in 59 min');
      expect(formatStartsIn(at('2026-11-15T10:59:30Z'), now, 'UTC')).toBe('in 1 h');
    });

    it('counts hours and minutes later today', () => {
      expect(formatStartsIn(at('2026-11-15T11:00:00Z'), now, 'UTC')).toBe('in 1 h');
      expect(formatStartsIn(at('2026-11-15T12:05:00Z'), now, 'UTC')).toBe('in 2 h 05');
      expect(formatStartsIn(at('2026-11-15T23:59:00Z'), now, 'UTC')).toBe('in 13 h 59');
    });

    it('says tomorrow for the next calendar day, even less than 24 hours away', () => {
      expect(formatStartsIn(at('2026-11-16T09:00:00Z'), now, 'UTC')).toBe('tomorrow at 09:00');
      expect(formatStartsIn(at('2026-11-16T00:30:00Z'), at('2026-11-15T22:00:00Z'), 'UTC')).toBe(
        'tomorrow at 00:30',
      );
      expect(formatStartsIn(at('2026-11-16T23:00:00Z'), now, 'UTC')).toBe('tomorrow at 23:00');
    });

    it('keeps minutes just after midnight', () => {
      expect(formatStartsIn(at('2026-11-16T00:15:00Z'), at('2026-11-15T23:30:00Z'), 'UTC')).toBe(
        'in 45 min',
      );
    });

    it('counts calendar days after tomorrow', () => {
      expect(formatStartsIn(at('2026-11-17T08:00:00Z'), at('2026-11-15T23:00:00Z'), 'UTC')).toBe(
        'in 2 days',
      );
      expect(formatStartsIn(at('2026-11-21T10:00:00Z'), now, 'UTC')).toBe('in 6 days');
    });

    it('uses calendar days of the given time zone', () => {
      // 23:30 UTC is already the 16th in Paris (UTC+1), so 09:00 UTC on the 16th is today there.
      const lateUtc = at('2026-11-15T23:30:00Z');
      expect(formatStartsIn(at('2026-11-16T09:00:00Z'), lateUtc, 'UTC')).toBe('tomorrow at 09:00');
      expect(formatStartsIn(at('2026-11-16T09:00:00Z'), lateUtc, 'Europe/Paris')).toBe('in 9 h 30');
      expect(formatStartsIn(at('2026-11-16T09:00:00Z'), now, 'Europe/Paris')).toBe(
        'tomorrow at 10:00',
      );
    });
  });
});
