import { describe, expect, it } from 'vitest';
import {
  addDays,
  eventInputToIso,
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
});
