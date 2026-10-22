import ICAL from 'ical.js';
import { MAX_RECURRENCE_ITERATIONS } from '../config';
import { addDays, diffDays, instantToWall, wallToInstant } from '../util/dates';
import {
  addTimeProperty,
  applyFields,
  applyRule,
  applyTimes,
  EventNotFoundError,
  findMasterEvent,
  initNewEvent,
  instantToTime,
  parseInstant,
  RECURRENCE_PROPS,
  removeEvent,
  setTimeProperty,
  textValue,
  touch,
  tzidParam,
  zoneSpecOfValue,
  type EventDraft,
} from './edit';
import { timeToInstant } from './recurrence';
import { simpleRuleFromRecur, type SimpleRule } from './rrule';

/** Which occurrences of a series an edit or delete applies to. */
export type EditScope = 'this' | 'following' | 'all';

/** One occurrence of a series, as the user saw it. */
export interface OccurrenceRef {
  uid: string;
  recurrenceId: ICAL.Time;
  /** The occurrence's times as displayed (draft format), to compute how far an edit moved it. */
  original: Pick<EventDraft, 'allDay' | 'start' | 'end'>;
}

type Shift = { kind: 'ms'; ms: number } | { kind: 'days'; days: number };

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const dateOf = (t: ICAL.Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;

function instantMs(t: ICAL.Time, tzid: string | null): number {
  return timeToInstant(t, tzid).date.getTime();
}

function overridesOf(vcalendar: ICAL.Component, uid: string): ICAL.Component[] {
  return vcalendar
    .getAllSubcomponents('vevent')
    .filter((v) => textValue(v, 'uid') === uid && v.hasProperty('recurrence-id'));
}

function recurrenceIdMs(override: ICAL.Component): number {
  const prop = override.getFirstProperty('recurrence-id')!;
  return instantMs(prop.getFirstValue() as ICAL.Time, tzidParam(prop));
}

/** TZID to interpret RECURRENCE-IDs of this series with (they follow DTSTART). */
function seriesTzid(vcalendar: ICAL.Component, uid: string): string | null {
  const master = findMasterEvent(vcalendar, uid);
  if (master) return tzidParam(master.getFirstProperty('dtstart'));
  const override = overridesOf(vcalendar, uid)[0];
  return override ? tzidParam(override.getFirstProperty('recurrence-id')) : null;
}

function findOverride(vcalendar: ICAL.Component, ref: OccurrenceRef): ICAL.Component | null {
  const target = instantMs(ref.recurrenceId, seriesTzid(vcalendar, ref.uid));
  return overridesOf(vcalendar, ref.uid).find((o) => recurrenceIdMs(o) === target) ?? null;
}

function requireMaster(vcalendar: ICAL.Component, uid: string): ICAL.Component {
  const master = findMasterEvent(vcalendar, uid);
  if (!master) throw new EventNotFoundError(`Event ${uid} was not found.`);
  return master;
}

function dtstartOf(master: ICAL.Component): { time: ICAL.Time; tzid: string | null } {
  const prop = master.getFirstProperty('dtstart');
  const time = prop?.getFirstValue();
  if (!(time instanceof ICAL.Time)) throw new EventNotFoundError('The event has no start.');
  return { time, tzid: tzidParam(prop) };
}

function shiftTime(t: ICAL.Time, tzid: string | null, shift: Shift, displayTimeZone: string) {
  if (shift.kind === 'days' || t.isDate) {
    const days = shift.kind === 'days' ? shift.days : Math.round(shift.ms / 86_400_000);
    const shifted = t.clone();
    shifted.adjust(days, 0, 0, 0);
    return shifted;
  }
  const spec = zoneSpecOfValue(t, tzid)!;
  return instantToTime(instantMs(t, tzid) + shift.ms, spec, displayTimeZone).time;
}

const isZeroShift = (s: Shift) => (s.kind === 'ms' ? s.ms === 0 : s.days === 0);

/**
 * Rewrites the time values of every `name` property (EXDATE/RDATE can hold several values).
 * `fn` returns the replacement, or null to drop the value. Non-time values (PERIOD) are kept.
 */
function rewriteTimeList(
  component: ICAL.Component,
  name: string,
  fn: (value: ICAL.Time, tzid: string | null) => ICAL.Time | null,
): void {
  for (const prop of component.getAllProperties(name)) {
    const tzid = tzidParam(prop);
    const next: unknown[] = [];
    for (const value of prop.getValues()) {
      if (!(value instanceof ICAL.Time)) next.push(value);
      else {
        const replaced = fn(value, tzid);
        if (replaced) next.push(replaced);
      }
    }
    if (next.length === 0) component.removeProperty(prop);
    else prop.setValues(next as ICAL.Time[]);
  }
}

/**
 * The UNTIL value that ends a series just before the occurrence `rid`: a DATE for all-day series,
 * floating time for floating series, UTC otherwise (RFC 5545).
 */
function untilBefore(rid: ICAL.Time, dtstart: ICAL.Time, tzid: string | null): ICAL.Time {
  if (dtstart.isDate) {
    const until = rid.clone();
    until.isDate = true;
    until.adjust(-1, 0, 0, 0);
    return until;
  }
  if (!tzid && dtstart.zone !== ICAL.Timezone.utcTimezone) {
    const until = rid.clone();
    until.adjust(0, 0, 0, -1);
    return until;
  }
  return ICAL.Time.fromJSDate(new Date(instantMs(rid, tzid) - 1000), true);
}

/** The series' rule for the editor: a SimpleRule, or `custom` when it can't be represented. */
export function seriesRule(
  vcalendar: ICAL.Component,
  uid: string,
  displayTimeZone: string,
): { rule: SimpleRule | null; custom: boolean } {
  const master = findMasterEvent(vcalendar, uid);
  if (!master) return { rule: null, custom: false };
  const recur = master.getFirstPropertyValue('rrule');
  if (!(recur instanceof ICAL.Recur)) return { rule: null, custom: master.hasProperty('rdate') };
  const rule = simpleRuleFromRecur(recur, displayTimeZone);
  return { rule, custom: rule === null };
}

/** Edits one occurrence: creates (or updates) a RECURRENCE-ID override. */
export function editOccurrence(
  vcalendar: ICAL.Component,
  ref: OccurrenceRef,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
): void {
  let override = findOverride(vcalendar, ref);
  if (!override) {
    const master = requireMaster(vcalendar, ref.uid);
    override = new ICAL.Component(structuredClone(master.toJSON()));
    for (const name of RECURRENCE_PROPS) override.removeAllProperties(name);
    setTimeProperty(
      override,
      'recurrence-id',
      ref.recurrenceId.clone(),
      tzidParam(master.getFirstProperty('dtstart')),
    );
    vcalendar.addSubcomponent(override);
  }
  applyFields(override, draft);
  applyTimes(override, vcalendar, draft, displayTimeZone);
  touch(override, now);
}

/** Deletes one occurrence: drops its override and adds an EXDATE to the series. */
export function deleteOccurrence(
  vcalendar: ICAL.Component,
  ref: OccurrenceRef,
  now = new Date(),
): void {
  const override = findOverride(vcalendar, ref);
  if (override) vcalendar.removeSubcomponent(override);
  const master = findMasterEvent(vcalendar, ref.uid);
  if (!master) {
    if (!override) throw new EventNotFoundError(`Event ${ref.uid} was not found.`);
    return;
  }
  addTimeProperty(
    master,
    'exdate',
    ref.recurrenceId.clone(),
    tzidParam(master.getFirstProperty('dtstart')),
  );
  touch(master, now);
}

/**
 * New DTSTART/DTEND for the whole series when one occurrence was edited from `original` to
 * `draft`: the series moves by the same amount, and takes the draft's duration.
 */
function seriesTimes(
  dtstart: ICAL.Time,
  tzid: string | null,
  original: OccurrenceRef['original'],
  draft: EventDraft,
  displayTimeZone: string,
): { times: Pick<EventDraft, 'allDay' | 'start' | 'end'>; shift: Shift } {
  const wallDate = (value: string, allDay: boolean) =>
    allDay ? value : instantToWall(parseInstant(value), displayTimeZone).date;
  const dayShift = diffDays(
    wallDate(draft.start, draft.allDay),
    wallDate(original.start, original.allDay),
  );
  const masterDate = dtstart.isDate
    ? dateOf(dtstart)
    : instantToWall(instantMs(dtstart, tzid), displayTimeZone).date;

  if (draft.allDay) {
    const start = addDays(masterDate, dayShift);
    const days = Math.max(1, diffDays(draft.end, draft.start));
    return {
      times: { allDay: true, start, end: addDays(start, days) },
      shift: { kind: 'days', days: dayShift },
    };
  }

  const duration = Math.max(0, parseInstant(draft.end) - parseInstant(draft.start));
  let startMs: number;
  let shift: Shift;
  if (!original.allDay && !dtstart.isDate) {
    const delta = parseInstant(draft.start) - parseInstant(original.start);
    startMs = instantMs(dtstart, tzid) + delta;
    shift = { kind: 'ms', ms: delta };
  } else {
    // Switching between all-day and timed: same day, the draft's time of day.
    const time = instantToWall(parseInstant(draft.start), displayTimeZone).time;
    startMs = wallToInstant(addDays(masterDate, dayShift), time, displayTimeZone);
    shift = { kind: 'days', days: dayShift };
  }
  return {
    times: {
      allDay: false,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + duration).toISOString(),
    },
    shift,
  };
}

const TEXT_FIELDS = ['summary', 'location', 'description'] as const;

/**
 * Edits the whole series. Times move by however much the edited occurrence moved. EXDATEs and
 * overrides move along; they are dropped when the rule or all-day setting changes, since they
 * would no longer match any occurrence. Overrides that kept the old title/location/description
 * get the new one.
 */
export function editSeries(
  vcalendar: ICAL.Component,
  ref: OccurrenceRef,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
): void {
  const master = requireMaster(vcalendar, ref.uid);
  const dtstart = dtstartOf(master);
  const before = Object.fromEntries(TEXT_FIELDS.map((f) => [f, textValue(master, f)]));
  const { times, shift } = seriesTimes(
    dtstart.time,
    dtstart.tzid,
    ref.original,
    draft,
    displayTimeZone,
  );
  const dropExceptions = draft.rrule !== undefined || draft.allDay !== dtstart.time.isDate;

  applyFields(master, draft);
  applyTimes(master, vcalendar, times, displayTimeZone);
  applyRule(master, draft.rrule, displayTimeZone);

  const overrides = overridesOf(vcalendar, ref.uid);
  if (dropExceptions) {
    master.removeAllProperties('exdate');
    for (const override of overrides) vcalendar.removeSubcomponent(override);
  } else {
    if (!isZeroShift(shift)) {
      const move = (v: ICAL.Time, tzid: string | null) =>
        shiftTime(v, tzid, shift, displayTimeZone);
      rewriteTimeList(master, 'exdate', move);
      rewriteTimeList(master, 'rdate', move);
      for (const override of overrides) {
        const prop = override.getFirstProperty('recurrence-id')!;
        const tzid = tzidParam(prop);
        setTimeProperty(
          override,
          'recurrence-id',
          move(prop.getFirstValue() as ICAL.Time, tzid),
          tzid,
        );
      }
    }
    for (const override of overrides) {
      for (const field of TEXT_FIELDS) {
        if (textValue(override, field) !== before[field]) continue;
        const value = textValue(master, field);
        if (value) override.updatePropertyWithValue(field, value);
        else override.removeAllProperties(field);
      }
    }
  }
  touch(master, now);
}

/** Number of occurrences the rule generates before `splitMs` (EXDATEs still count, per RFC). */
function occurrencesBefore(
  recur: ICAL.Recur,
  dtstart: ICAL.Time,
  tzid: string | null,
  splitMs: number,
): number {
  const iterator = recur.iterator(dtstart);
  let count = 0;
  for (let i = 0; i < MAX_RECURRENCE_ITERATIONS; i++) {
    const next = iterator.next();
    if (!next || instantMs(next, tzid) >= splitMs) break;
    count++;
  }
  return count;
}

/** Ends the series just before the split occurrence and drops everything from there on. */
function truncateSeries(
  vcalendar: ICAL.Component,
  master: ICAL.Component,
  ref: OccurrenceRef,
  splitMs: number,
): void {
  const dtstart = dtstartOf(master);
  const recurProp = master.getFirstProperty('rrule');
  const recur = recurProp?.getFirstValue();
  if (recurProp && recur instanceof ICAL.Recur) {
    const ended = ICAL.Recur.fromString(recur.toString());
    ended.count = null;
    ended.until = untilBefore(ref.recurrenceId, dtstart.time, dtstart.tzid);
    recurProp.setValue(ended);
  }
  const keepBefore = (v: ICAL.Time, tzid: string | null) =>
    instantMs(v, tzid) < splitMs ? v : null;
  rewriteTimeList(master, 'exdate', keepBefore);
  rewriteTimeList(master, 'rdate', keepBefore);
  for (const override of overridesOf(vcalendar, ref.uid)) {
    if (recurrenceIdMs(override) >= splitMs) vcalendar.removeSubcomponent(override);
  }
}

/**
 * Edits this and the following occurrences: the series ends before this occurrence, and a new
 * series (new UID) starts here with the draft. Later EXDATEs and overrides move to the new series
 * (shifted like the occurrence), unless the rule or all-day setting changed. Returns the new UID.
 */
export function editFollowing(
  vcalendar: ICAL.Component,
  ref: OccurrenceRef,
  draft: EventDraft,
  displayTimeZone: string,
  now = new Date(),
  newUid: string = crypto.randomUUID(),
): string {
  const master = requireMaster(vcalendar, ref.uid);
  const dtstart = dtstartOf(master);
  const splitMs = instantMs(ref.recurrenceId, dtstart.tzid);
  const recur = master.getFirstPropertyValue('rrule');
  if (splitMs <= instantMs(dtstart.time, dtstart.tzid) || !(recur instanceof ICAL.Recur)) {
    editSeries(vcalendar, ref, draft, displayTimeZone, now);
    return ref.uid;
  }

  // The new series: a copy of the old one (keeps alarms, attendees, X- properties...).
  const series = new ICAL.Component(structuredClone(master.toJSON()));
  initNewEvent(series, newUid, now);
  series.removeAllProperties('exdate');
  series.removeAllProperties('rdate');
  applyFields(series, draft);
  applyTimes(series, vcalendar, draft, displayTimeZone);
  if (draft.rrule !== undefined) applyRule(series, draft.rrule, displayTimeZone);
  else {
    const continued = ICAL.Recur.fromString(recur.toString());
    if (recur.count) {
      const done = occurrencesBefore(recur, dtstart.time, dtstart.tzid, splitMs);
      continued.count = Math.max(1, recur.count - done);
    }
    series.updatePropertyWithValue('rrule', continued);
  }

  const keepExceptions = draft.rrule === undefined && draft.allDay === dtstart.time.isDate;
  const shift: Shift = draft.allDay
    ? { kind: 'days', days: diffDays(draft.start, dateOf(ref.recurrenceId)) }
    : { kind: 'ms', ms: parseInstant(draft.start) - splitMs };

  if (keepExceptions) {
    for (const name of ['exdate', 'rdate']) {
      for (const prop of master.getAllProperties(name)) {
        const tzid = tzidParam(prop);
        for (const value of prop.getValues()) {
          if (value instanceof ICAL.Time && instantMs(value, tzid) >= splitMs) {
            addTimeProperty(series, name, shiftTime(value, tzid, shift, displayTimeZone), tzid);
          }
        }
      }
    }
    for (const override of overridesOf(vcalendar, ref.uid)) {
      const ms = recurrenceIdMs(override);
      // The override of the split occurrence itself is replaced by the new series' first one.
      if (ms <= splitMs) continue;
      const prop = override.getFirstProperty('recurrence-id')!;
      const tzid = tzidParam(prop);
      const moved = new ICAL.Component(structuredClone(override.toJSON()));
      moved.updatePropertyWithValue('uid', newUid);
      setTimeProperty(
        moved,
        'recurrence-id',
        shiftTime(prop.getFirstValue() as ICAL.Time, tzid, shift, displayTimeZone),
        tzid,
      );
      vcalendar.addSubcomponent(moved);
    }
  }

  truncateSeries(vcalendar, master, ref, splitMs);
  touch(master, now);
  vcalendar.addSubcomponent(series);
  return newUid;
}

/** Deletes this and the following occurrences (the whole series if this is the first one). */
export function deleteFollowing(
  vcalendar: ICAL.Component,
  ref: OccurrenceRef,
  now = new Date(),
): void {
  const master = requireMaster(vcalendar, ref.uid);
  const dtstart = dtstartOf(master);
  const splitMs = instantMs(ref.recurrenceId, dtstart.tzid);
  if (splitMs <= instantMs(dtstart.time, dtstart.tzid)) {
    removeEvent(vcalendar, ref.uid);
    return;
  }
  truncateSeries(vcalendar, master, ref, splitMs);
  touch(master, now);
}
