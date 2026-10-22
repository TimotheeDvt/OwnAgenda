import ICAL from 'ical.js';
import { epochToZonedArray, isValidTimeZone } from '../util/timeZone';
import { recurFromSimpleRule, type SimpleRule } from './rrule';

/**
 * The editable fields of an event.
 * - All-day: `start`/`end` are "YYYY-MM-DD", with `end` exclusive (the day after the last day).
 * - Timed: `start`/`end` are anything Date.parse accepts with a fixed offset (ISO instants).
 * - `rrule`: undefined keeps the current rule, null removes it, a SimpleRule replaces it.
 */
export interface EventDraft {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location?: string;
  description?: string;
  rrule?: SimpleRule | null;
}

/** How a DATE-TIME is written: in UTC, as floating local time, or with a TZID. */
export type ZoneSpec = { kind: 'utc' } | { kind: 'floating' } | { kind: 'tzid'; tzid: string };

export class EventNotFoundError extends Error {
  override name = 'EventNotFoundError';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Properties that make a VEVENT a recurring series. */
export const RECURRENCE_PROPS = ['rrule', 'rdate', 'exdate', 'exrule'] as const;

export function textValue(component: ICAL.Component, name: string): string | undefined {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : undefined;
}

/** The main VEVENT (no RECURRENCE-ID) with this UID. */
export function findMasterEvent(vcalendar: ICAL.Component, uid: string): ICAL.Component | null {
  return (
    vcalendar
      .getAllSubcomponents('vevent')
      .find((v) => textValue(v, 'uid') === uid && !v.hasProperty('recurrence-id')) ?? null
  );
}

export function isRecurringComponent(vevent: ICAL.Component): boolean {
  return vevent.hasProperty('rrule') || vevent.hasProperty('rdate');
}

export function hasTimezone(vcalendar: ICAL.Component, tzid: string): boolean {
  return vcalendar
    .getAllSubcomponents('vtimezone')
    .some((tz) => tz.getFirstPropertyValue('tzid') === tzid);
}

export function tzidParam(prop: ICAL.Property | null): string | null {
  const tzid = prop?.getParameter('tzid');
  return typeof tzid === 'string' && tzid ? tzid : null;
}

/** The zone a time value is written in, or null for DATE values. */
export function zoneSpecOfValue(value: ICAL.Time, tzid: string | null): ZoneSpec | null {
  if (value.isDate) return null;
  if (tzid) return { kind: 'tzid', tzid };
  return value.zone === ICAL.Timezone.utcTimezone ? { kind: 'utc' } : { kind: 'floating' };
}

/** The zone an existing DTSTART/DTEND is written in, or null for DATE values or no property. */
export function zoneSpecOf(component: ICAL.Component, propName: string): ZoneSpec | null {
  const prop = component.getFirstProperty(propName);
  if (!prop) return null;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  return zoneSpecOfValue(value, tzidParam(prop));
}

/**
 * Zone for new timed values: the display timezone when the file defines it (VTIMEZONE), so the
 * file stays readable and RFC 5545 compliant; otherwise UTC.
 */
function defaultZoneSpec(vcalendar: ICAL.Component, displayTimeZone: string): ZoneSpec {
  return hasTimezone(vcalendar, displayTimeZone)
    ? { kind: 'tzid', tzid: displayTimeZone }
    : { kind: 'utc' };
}

function fromArray(a: number[], isDate = false): ICAL.Time {
  return ICAL.Time.fromData({
    year: a[0] ?? 1970,
    month: (a[1] ?? 0) + 1,
    day: a[2] ?? 1,
    hour: a[3] ?? 0,
    minute: a[4] ?? 0,
    second: a[5] ?? 0,
    isDate,
  });
}

export function parseInstant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || DATE_RE.test(value)) {
    throw new RangeError(`Invalid date-time: "${value}"`);
  }
  return ms;
}

export function parseDate(value: string): ICAL.Time {
  if (!DATE_RE.test(value)) throw new RangeError(`Invalid date: "${value}"`);
  return ICAL.Time.fromDateString(value);
}

/** Builds the ICAL.Time for an instant, plus the TZID parameter to write (if any). */
export function instantToTime(
  ms: number,
  spec: ZoneSpec,
  displayTimeZone: string,
): { time: ICAL.Time; tzid: string | null } {
  switch (spec.kind) {
    case 'utc':
      return { time: ICAL.Time.fromJSDate(new Date(ms), true), tzid: null };
    case 'floating':
      // Floating times are shown as wall-clock time in the display zone, so write them back so.
      return { time: fromArray(epochToZonedArray(ms, displayTimeZone)), tzid: null };
    case 'tzid': {
      const zone = ICAL.TimezoneService.get(spec.tzid);
      if (zone) {
        return {
          time: ICAL.Time.fromJSDate(new Date(ms), true).convertToZone(zone),
          tzid: spec.tzid,
        };
      }
      if (isValidTimeZone(spec.tzid)) {
        // TZID without a VTIMEZONE (non-compliant but common): keep it, compute with Intl.
        return { time: fromArray(epochToZonedArray(ms, spec.tzid)), tzid: spec.tzid };
      }
      return { time: ICAL.Time.fromJSDate(new Date(ms), true), tzid: null };
    }
  }
}

function writeTime(prop: ICAL.Property, time: ICAL.Time, tzid: string | null): void {
  prop.removeParameter('value');
  if (tzid) prop.setParameter('tzid', tzid);
  else prop.removeParameter('tzid');
  prop.setValue(time);
}

/** Sets (or creates) the first property `name` to a time value. */
export function setTimeProperty(
  component: ICAL.Component,
  name: string,
  time: ICAL.Time,
  tzid: string | null,
): void {
  let prop = component.getFirstProperty(name);
  if (!prop) {
    prop = new ICAL.Property(name);
    component.addProperty(prop);
  }
  writeTime(prop, time, tzid);
}

/** Adds another property `name` with a time value (for EXDATE, which can repeat). */
export function addTimeProperty(
  component: ICAL.Component,
  name: string,
  time: ICAL.Time,
  tzid: string | null,
): void {
  const prop = new ICAL.Property(name);
  writeTime(prop, time, tzid);
  component.addProperty(prop);
}

function setOptionalText(component: ICAL.Component, name: string, value: string | undefined) {
  if (value && value.trim()) component.updatePropertyWithValue(name, value);
  else component.removeAllProperties(name);
}

export function nowUtc(now: Date): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(Math.floor(now.getTime() / 1000) * 1000), true);
}

/** Writes DTSTART/DTEND, keeping each value's existing zone style when it stays timed. */
export function applyTimes(
  vevent: ICAL.Component,
  vcalendar: ICAL.Component,
  draft: Pick<EventDraft, 'allDay' | 'start' | 'end'>,
  displayTimeZone: string,
): void {
  if (draft.allDay) {
    const start = parseDate(draft.start);
    let end = parseDate(draft.end);
    if (end.compare(start) <= 0) {
      end = start.clone();
      end.adjust(1, 0, 0, 0);
    }
    setTimeProperty(vevent, 'dtstart', start, null);
    setTimeProperty(vevent, 'dtend', end, null);
  } else {
    const startMs = parseInstant(draft.start);
    const endMs = Math.max(parseInstant(draft.end), startMs);
    const fallback = defaultZoneSpec(vcalendar, displayTimeZone);
    const startSpec = zoneSpecOf(vevent, 'dtstart') ?? fallback;
    const endSpec = zoneSpecOf(vevent, 'dtend') ?? startSpec;
    const start = instantToTime(startMs, startSpec, displayTimeZone);
    const end = instantToTime(endMs, endSpec, displayTimeZone);
    setTimeProperty(vevent, 'dtstart', start.time, start.tzid);
    setTimeProperty(vevent, 'dtend', end.time, end.tzid);
  }
  // DTEND replaces any DURATION (they are mutually exclusive).
  vevent.removeAllProperties('duration');
}

export function applyFields(
  vevent: ICAL.Component,
  draft: Pick<EventDraft, 'title' | 'location' | 'description'>,
): void {
  setOptionalText(vevent, 'summary', draft.title);
  setOptionalText(vevent, 'location', draft.location);
  setOptionalText(vevent, 'description', draft.description);
}

/** Sets or removes the RRULE (relative to the current DTSTART). No-op when `rule` is undefined. */
export function applyRule(
  vevent: ICAL.Component,
  rule: SimpleRule | null | undefined,
  displayTimeZone: string,
): void {
  if (rule === undefined) return;
  if (rule === null) {
    vevent.removeAllProperties('rrule');
    return;
  }
  const dtstartProp = vevent.getFirstProperty('dtstart');
  const dtstart = dtstartProp?.getFirstValue();
  if (!(dtstart instanceof ICAL.Time)) return;
  const recur = recurFromSimpleRule(rule, dtstart, tzidParam(dtstartProp), displayTimeZone);
  vevent.updatePropertyWithValue('rrule', recur);
}

/** Updates DTSTAMP and LAST-MODIFIED and bumps SEQUENCE, as RFC 5545 asks on every change. */
export function touch(vevent: ICAL.Component, now: Date): void {
  const stamp = nowUtc(now);
  vevent.updatePropertyWithValue('dtstamp', stamp);
  vevent.updatePropertyWithValue('last-modified', stamp.clone());
  const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
  vevent.updatePropertyWithValue('sequence', Number.isFinite(sequence) ? sequence + 1 : 1);
}

/** Sets the identity and timestamps of a brand-new VEVENT. */
export function initNewEvent(vevent: ICAL.Component, uid: string, now: Date): void {
  const stamp = nowUtc(now);
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('dtstamp', stamp);
  vevent.updatePropertyWithValue('created', stamp.clone());
  vevent.updatePropertyWithValue('last-modified', stamp.clone());
  vevent.updatePropertyWithValue('sequence', 0);
}

/** Adds a new VEVENT to the calendar and returns its UID. */
export function createEvent(
  vcalendar: ICAL.Component,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
  uid: string = crypto.randomUUID(),
): string {
  const vevent = new ICAL.Component('vevent');
  initNewEvent(vevent, uid, now);
  applyFields(vevent, draft);
  applyTimes(vevent, vcalendar, draft, displayTimeZone);
  applyRule(vevent, draft.rrule, displayTimeZone);
  vcalendar.addSubcomponent(vevent);
  return uid;
}

/**
 * Updates a non-recurring VEVENT in place, so properties the app doesn't know about are kept.
 * A draft with an `rrule` turns it into a series.
 */
export function updateEvent(
  vcalendar: ICAL.Component,
  uid: string,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
): void {
  const vevent = findMasterEvent(vcalendar, uid);
  if (!vevent) throw new EventNotFoundError(`Event ${uid} was not found.`);
  applyFields(vevent, draft);
  applyTimes(vevent, vcalendar, draft, displayTimeZone);
  applyRule(vevent, draft.rrule, displayTimeZone);
  touch(vevent, now);
}

/** Removes every VEVENT with this UID (the event and any overrides) and returns them. */
export function removeEvent(vcalendar: ICAL.Component, uid: string): ICAL.Component[] {
  const removed = vcalendar
    .getAllSubcomponents('vevent')
    .filter((v) => textValue(v, 'uid') === uid);
  if (removed.length === 0) throw new EventNotFoundError(`Event ${uid} was not found.`);
  for (const vevent of removed) vcalendar.removeSubcomponent(vevent);
  return removed;
}

/**
 * Moves every VEVENT with this UID to another calendar, copying the VTIMEZONEs they reference
 * that the target lacks.
 */
export function moveComponents(source: ICAL.Component, target: ICAL.Component, uid: string): void {
  for (const vevent of removeEvent(source, uid)) {
    for (const prop of vevent.getAllProperties()) {
      const tzid = tzidParam(prop);
      if (!tzid || hasTimezone(target, tzid)) continue;
      const vtz = source
        .getAllSubcomponents('vtimezone')
        .find((tz) => tz.getFirstPropertyValue('tzid') === tzid);
      if (vtz) target.addSubcomponent(new ICAL.Component(structuredClone(vtz.toJSON())));
    }
    target.addSubcomponent(vevent);
  }
}

/** Moves a non-recurring event to another calendar, then applies the draft. */
export function moveEvent(
  source: ICAL.Component,
  target: ICAL.Component,
  uid: string,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
): void {
  moveComponents(source, target, uid);
  updateEvent(target, uid, draft, displayTimeZone, now);
}

/** A new, empty VCALENDAR named `name` (X-WR-CALNAME). */
export function newCalendarComponent(name: string): ICAL.Component {
  const vcalendar = new ICAL.Component('vcalendar');
  vcalendar.addPropertyWithValue('version', '2.0');
  vcalendar.addPropertyWithValue('prodid', '-//ICS Agenda//EN');
  vcalendar.addPropertyWithValue('calscale', 'GREGORIAN');
  vcalendar.addPropertyWithValue('x-wr-calname', name);
  return vcalendar;
}

export function renameCalendarComponent(vcalendar: ICAL.Component, name: string): void {
  vcalendar.updatePropertyWithValue('x-wr-calname', name);
}
