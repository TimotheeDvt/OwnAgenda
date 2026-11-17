// Days marked by a dot for the calendars shown as "dots only" (see CalendarSettings.dotsOnly).

import type { AgendaEvent } from '../types';

type Timing = Pick<AgendaEvent, 'start' | 'end' | 'allDay' | 'startInput' | 'endInput'>;

const MAX_DAYS = 366;

/** "YYYY-MM-DD" plus `n` days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Every day ("YYYY-MM-DD") an event touches. `dayOf` gives the day of an instant in the display
 * time zone; floating times and all-day events already carry their day in their input string.
 * An end at exactly midnight (or the exclusive end of an all-day event) is not a day of the event.
 */
export function eventDays(event: Timing, dayOf: (instant: Date) => string): string[] {
  const zoned = (input: string) => input.endsWith('Z');
  const first =
    event.allDay || !zoned(event.startInput) ? event.startInput.slice(0, 10) : dayOf(event.start);
  let last: string;
  if (event.allDay) {
    const end = event.endInput.slice(0, 10);
    last = end > first ? addDays(end, -1) : first;
  } else if (zoned(event.endInput)) {
    last = event.end > event.start ? dayOf(new Date(event.end.getTime() - 1)) : first;
  } else {
    const end = event.endInput.slice(0, 10);
    const atMidnight = event.endInput.slice(11, 19) === '00:00:00';
    last = end > first ? (atMidnight ? addDays(end, -1) : end) : first;
  }
  const days: string[] = [];
  for (let day = first; day <= last && days.length < MAX_DAYS; day = addDays(day, 1)) {
    days.push(day);
  }
  return days.length ? days : [first];
}
