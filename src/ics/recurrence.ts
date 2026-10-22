import ICAL from 'ical.js';
import { MAX_RECURRENCE_ITERATIONS } from '../config';
import type { AgendaEvent, DateRange } from '../types';
import { isValidTimeZone, zonedArrayToEpoch } from '../util/timeZone';

const DAY_MS = 86_400_000;

/**
 * All-day and floating times have no fixed instant, so range checks are widened by this much
 * on each side; FullCalendar clips anything outside the visible range anyway.
 */
const RANGE_SLACK_MS = DAY_MS;

interface Instant {
  date: Date;
  input: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function dateString(t: ICAL.Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

function localDateTimeString(t: ICAL.Time): string {
  return `${dateString(t)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

/**
 * Converts an ical.js time into an absolute Date plus a FullCalendar input string.
 * `tzidHint` is the TZID parameter of the source property: when ical.js has no VTIMEZONE for it
 * (non-compliant files often omit it) but it is a valid IANA name, Intl is used instead.
 */
export function timeToInstant(t: ICAL.Time, tzidHint?: string | null): Instant {
  if (t.isDate) {
    return { date: new Date(t.year, t.month - 1, t.day), input: dateString(t) };
  }
  const zoneId = t.zone?.tzid;
  if (zoneId && zoneId !== 'floating') {
    const date = t.toJSDate();
    return { date, input: date.toISOString() };
  }
  if (tzidHint && isValidTimeZone(tzidHint)) {
    const ms = zonedArrayToEpoch(
      [t.year, t.month - 1, t.day, t.hour, t.minute, t.second, 0],
      tzidHint,
    );
    const date = new Date(ms);
    return { date, input: date.toISOString() };
  }
  // Floating time: same wall-clock time in whatever zone the calendar is displayed in.
  return {
    date: new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second),
    input: localDateTimeString(t),
  };
}

function tzidOf(component: ICAL.Component, propName: string): string | null {
  const value = component.getFirstProperty(propName)?.getParameter('tzid');
  return typeof value === 'string' ? value : null;
}

function textProp(component: ICAL.Component, name: string): string | undefined {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function buildEvent(
  calendarFileId: string,
  id: string,
  component: ICAL.Component,
  startTime: ICAL.Time,
  endTime: ICAL.Time,
  recurring: boolean,
  recurrenceId?: ICAL.Time,
): AgendaEvent {
  const startTzid = tzidOf(component, 'dtstart');
  const start = timeToInstant(startTime, startTzid);
  const end = timeToInstant(endTime, tzidOf(component, 'dtend') ?? startTzid);
  return {
    id,
    uid: textProp(component, 'uid') ?? '',
    calendarFileId,
    title: textProp(component, 'summary') ?? '',
    start: start.date,
    end: end.date,
    allDay: startTime.isDate,
    location: textProp(component, 'location'),
    description: textProp(component, 'description'),
    recurring,
    recurrenceId: recurrenceId?.clone(),
    startInput: start.input,
    endInput: end.input,
  };
}

function overlaps(event: AgendaEvent, range: DateRange): boolean {
  const isExactInstant = event.startInput.endsWith('Z');
  const slack = isExactInstant ? 0 : RANGE_SLACK_MS;
  const from = range.start.getTime() - slack;
  const to = range.end.getTime() + slack;
  const start = event.start.getTime();
  const end = event.end.getTime();
  // Zero-length events count when they start inside the range.
  return start < to && (end > from || (end === start && start >= from));
}

/**
 * Returns every event occurrence of the calendar that overlaps the range. Recurring events are
 * expanded with their RRULE/RDATE/EXDATE, and RECURRENCE-ID overrides replace the matching
 * occurrence.
 */
export function expandCalendar(
  vcalendar: ICAL.Component,
  calendarFileId: string,
  range: DateRange,
  maxIterations = MAX_RECURRENCE_ITERATIONS,
): AgendaEvent[] {
  const masters: ICAL.Component[] = [];
  const exceptionsByUid = new Map<string, ICAL.Component[]>();

  for (const vevent of vcalendar.getAllSubcomponents('vevent')) {
    if (vevent.hasProperty('recurrence-id')) {
      const uid = textProp(vevent, 'uid') ?? '';
      const list = exceptionsByUid.get(uid) ?? [];
      list.push(vevent);
      exceptionsByUid.set(uid, list);
    } else {
      masters.push(vevent);
    }
  }

  const result: AgendaEvent[] = [];
  const rangeEnd = range.end.getTime() + RANGE_SLACK_MS;

  masters.forEach((master, index) => {
    const uid = textProp(master, 'uid') ?? `no-uid-${index}`;
    const exceptions = exceptionsByUid.get(uid) ?? [];
    exceptionsByUid.delete(uid);
    if (!master.hasProperty('dtstart')) return;
    const event = new ICAL.Event(master, { exceptions });

    if (!event.isRecurring()) {
      const occ = buildEvent(
        calendarFileId,
        `${calendarFileId}/${uid}`,
        master,
        event.startDate,
        event.endDate,
        false,
      );
      if (overlaps(occ, range)) result.push(occ);
      return;
    }

    const iterator = event.iterator();
    const masterTzid = tzidOf(master, 'dtstart');
    for (let i = 0; i < maxIterations; i++) {
      const next = iterator.next();
      if (!next) break;
      if (timeToInstant(next, masterTzid).date.getTime() > rangeEnd) break;
      const details = event.getOccurrenceDetails(next);
      const occ = buildEvent(
        calendarFileId,
        `${calendarFileId}/${uid}/${details.recurrenceId.toString()}`,
        details.item.component,
        details.startDate,
        details.endDate,
        true,
        details.recurrenceId,
      );
      if (overlaps(occ, range)) result.push(occ);
    }
  });

  // Overrides whose master is missing (e.g. invitations to a single occurrence): show them as-is.
  for (const [uid, orphans] of exceptionsByUid) {
    for (const component of orphans) {
      const event = new ICAL.Event(component);
      const occ = buildEvent(
        calendarFileId,
        `${calendarFileId}/${uid}/${event.recurrenceId?.toString() ?? ''}`,
        component,
        event.startDate,
        event.endDate,
        false,
        event.recurrenceId ?? undefined,
      );
      if (overlaps(occ, range)) result.push(occ);
    }
  }

  return result;
}
