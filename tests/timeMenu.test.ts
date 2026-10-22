import { describe, expect, it } from 'vitest';
import { HALF_HOURS } from '../src/ui/timeMenu';

describe('half-hour time list', () => {
  it('covers the whole day in 30-minute steps, 24-hour format', () => {
    expect(HALF_HOURS).toHaveLength(48);
    expect(HALF_HOURS.slice(0, 3)).toEqual(['00:00', '00:30', '01:00']);
    expect(HALF_HOURS[18]).toBe('09:00');
    expect(HALF_HOURS.at(-1)).toBe('23:30');
  });
});
