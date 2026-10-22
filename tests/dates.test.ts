import { describe, expect, it } from 'vitest';
import { addDays, eventInputToIso, instantToWall, wallToInstant } from '../src/util/dates';

describe('date helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
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
