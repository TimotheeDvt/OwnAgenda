import { describe, expect, it } from 'vitest';
import {
  epochToZonedArray,
  isValidTimeZone,
  zonedArrayToEpoch,
  zoneOffsetMinutes,
} from '../src/util/timeZone';

describe('timeZone utils', () => {
  it('validates IANA names', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('computes offsets on both sides of DST', () => {
    expect(zoneOffsetMinutes(Date.UTC(2025, 0, 15), 'Europe/Paris')).toBe(60);
    expect(zoneOffsetMinutes(Date.UTC(2025, 6, 15), 'Europe/Paris')).toBe(120);
    expect(zoneOffsetMinutes(Date.UTC(2025, 6, 15), 'America/New_York')).toBe(-240);
  });

  it('round-trips wall-clock arrays', () => {
    const a = [2025, 9, 26, 2, 30, 0, 0]; // ambiguous hour in Paris (DST ends 3:00 → 2:00)
    const ms = zonedArrayToEpoch(a, 'Europe/Paris');
    expect(epochToZonedArray(ms, 'Europe/Paris')).toEqual(a);
    expect(zonedArrayToEpoch([2025, 6, 1, 10, 0, 0, 0], 'Europe/Paris')).toBe(
      Date.UTC(2025, 6, 1, 8),
    );
  });

  it('keeps milliseconds and midnight as hour 0', () => {
    expect(epochToZonedArray(Date.UTC(2025, 0, 1, 23, 0, 0, 250), 'Europe/Paris')).toEqual([
      2025, 0, 2, 0, 0, 0, 250,
    ]);
  });
});
