import { describe, expect, it } from 'vitest';
import { addDays, eventDays } from '../src/util/dotDays';

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const timed = (start: string, end: string) => ({
  start: new Date(start),
  end: new Date(end),
  allDay: false,
  startInput: start,
  endInput: end,
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('eventDays', () => {
  it('gives one day for a short timed event', () => {
    expect(eventDays(timed('2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'), utcDay)).toEqual([
      '2026-03-02',
    ]);
  });

  it('spans every day of a multi-day timed event', () => {
    expect(eventDays(timed('2026-03-02T22:00:00Z', '2026-03-04T08:00:00Z'), utcDay)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('does not count an end at exactly midnight', () => {
    expect(eventDays(timed('2026-03-02T22:00:00Z', '2026-03-03T00:00:00Z'), utcDay)).toEqual([
      '2026-03-02',
    ]);
  });

  it('uses the display time zone for instants', () => {
    const plus2 = (d: Date) => utcDay(new Date(d.getTime() + 2 * 3_600_000));
    expect(eventDays(timed('2026-03-02T23:00:00Z', '2026-03-02T23:30:00Z'), plus2)).toEqual([
      '2026-03-03',
    ]);
  });

  it('treats all-day ends as exclusive', () => {
    const allDay = (start: string, end: string) => ({
      start: new Date(start),
      end: new Date(end),
      allDay: true,
      startInput: start,
      endInput: end,
    });
    expect(eventDays(allDay('2026-03-02', '2026-03-03'), utcDay)).toEqual(['2026-03-02']);
    expect(eventDays(allDay('2026-03-02', '2026-03-05'), utcDay)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('reads floating times from their wall-clock text', () => {
    const floating = {
      start: new Date('2026-03-02T09:00:00Z'),
      end: new Date('2026-03-03T10:00:00Z'),
      allDay: false,
      startInput: '2026-03-02T09:00:00',
      endInput: '2026-03-03T10:00:00',
    };
    expect(eventDays(floating, () => 'never')).toEqual(['2026-03-02', '2026-03-03']);
  });
});
