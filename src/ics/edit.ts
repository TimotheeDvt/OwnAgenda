import ICAL from 'ical.js';
import { epochToZonedArray, isValidTimeZone } from '../util/timeZone';

/**
 * The editable fields of a non-recurring event.
 * - All-day: `start`/`end` are "YYYY-MM-DD", with `end` exclusive (the day after the last day).
 * - Timed: `start`/`end` are anything Date.parse accepts with a fixed offset (ISO instants).
 */
export interface EventDraft {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

/** How a DATE-TIME is written: in UTC, as floating local time, or with a TZID. */
type ZoneSpec = { kind: 'utc' } | { kind: 'floating' } | { kind: 'tzid'; tzid: string };

export class EventNotFoundError extends Error {
  override name = 'EventNotFoundError';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function textValue(component: ICAL.Component, name: string): string | undefined {
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

function hasTimezone(vcalendar: ICAL.Component, tzid: string): boolean {
  return vcalendar
    .getAllSubcomponents('vtimezone')
    .some((tz) => tz.getFirstPropertyValue('tzid') === tzid);
}

/** The zone an existing DTSTART/DTEND is written in, or null for DATE values or no property. */
function zoneSpecOf(component: ICAL.Component, propName: string): ZoneSpec | null {
  const prop = component.getFirstProperty(propName);
  if (!prop) return null;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time) || value.isDate) return null;
  const tzid = prop.getParameter('tzid');
  if (typeof tzid === 'string' && tzid) return { kind: 'tzid', tzid };
  return value.zone === ICAL.Timezone.utcTimezone ? { kind: 'utc' } : { kind: 'floating' };
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

function parseInstant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || DATE_RE.test(value)) {
    throw new RangeError(`Invalid date-time: "${value}"`);
  }
  return ms;
}

function parseDate(value: string): ICAL.Time {
  if (!DATE_RE.test(value)) throw new RangeError(`Invalid date: "${value}"`);
  return ICAL.Time.fromDateString(value);
}

/** Builds the ICAL.Time for an instant, plus the TZID parameter to write (if any). */
function instantToTime(
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

function setTimeProperty(
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
  prop.removeParameter('value');
  if (tzid) prop.setParameter('tzid', tzid);
  else prop.removeParameter('tzid');
  prop.setValue(time);
}

function setOptionalText(component: ICAL.Component, name: string, value: string | undefined) {
  if (value && value.trim()) component.updatePropertyWithValue(name, value);
  else component.removeAllProperties(name);
}

function nowUtc(now: Date): ICAL.Time {
  return ICAL.Time.fromJSDate(new Date(Math.floor(now.getTime() / 1000) * 1000), true);
}

/** Writes DTSTART/DTEND, keeping each value's existing zone style when it stays timed. */
function applyTimes(
  vevent: ICAL.Component,
  vcalendar: ICAL.Component,
  draft: EventDraft,
  displayTimeZone: string,
): void {
  if (draft.allDay) {
    const start = parseDate(draft.start);
    let end = parseDate(draft.end);
    if (end.compare(start) <= 0) {
      end = start.clone();
      end.day += 1;
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

function applyFields(vevent: ICAL.Component, draft: EventDraft): void {
  setOptionalText(vevent, 'summary', draft.title);
  setOptionalText(vevent, 'location', draft.location);
  setOptionalText(vevent, 'description', draft.description);
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
  const stamp = nowUtc(now);
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('dtstamp', stamp);
  vevent.addPropertyWithValue('created', stamp.clone());
  vevent.addPropertyWithValue('last-modified', stamp.clone());
  vevent.addPropertyWithValue('sequence', 0);
  applyFields(vevent, draft);
  applyTimes(vevent, vcalendar, draft, displayTimeZone);
  vcalendar.addSubcomponent(vevent);
  return uid;
}

/**
 * Updates the VEVENT in place, so properties the app doesn't know about are kept. Bumps
 * SEQUENCE and sets DTSTAMP/LAST-MODIFIED.
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
  touch(vevent, now);
}

function touch(vevent: ICAL.Component, now: Date): void {
  const stamp = nowUtc(now);
  vevent.updatePropertyWithValue('dtstamp', stamp);
  vevent.updatePropertyWithValue('last-modified', stamp.clone());
  const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
  vevent.updatePropertyWithValue('sequence', Number.isFinite(sequence) ? sequence + 1 : 1);
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
 * Moves an event to another calendar, copying any VTIMEZONE it references that the target lacks,
 * then applies the draft.
 */
export function moveEvent(
  source: ICAL.Component,
  target: ICAL.Component,
  uid: string,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
): void {
  const components = removeEvent(source, uid);
  for (const vevent of components) {
    for (const prop of vevent.getAllProperties()) {
      const tzid = prop.getParameter('tzid');
      if (typeof tzid !== 'string' || hasTimezone(target, tzid)) continue;
      const vtz = source
        .getAllSubcomponents('vtimezone')
        .find((tz) => tz.getFirstPropertyValue('tzid') === tzid);
      if (vtz) target.addSubcomponent(new ICAL.Component(structuredClone(vtz.toJSON())));
    }
    target.addSubcomponent(vevent);
  }
  updateEvent(target, uid, draft, displayTimeZone, now);
}
