import ICAL from 'ical.js';
import { instantToWall, wallToInstant } from '../util/dates';
import { timeToInstant } from './recurrence';

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type RuleEnd =
  { type: 'never' } | { type: 'until'; date: string } | { type: 'count'; count: number };

/**
 * The subset of RRULE the editor supports: a frequency, an interval, weekdays for weekly rules,
 * and an end (never, on a date, or after N occurrences). Anything else is a "custom" rule that
 * the app keeps as-is.
 */
export interface SimpleRule {
  freq: Frequency;
  interval: number;
  /** Only used for WEEKLY; empty means "the weekday of the start date". */
  byDay: Weekday[];
  end: RuleEnd;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function dateString(t: ICAL.Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

const isFrequency = (v: unknown): v is Frequency => FREQUENCIES.includes(v as Frequency);
const isWeekday = (v: unknown): v is Weekday => WEEKDAYS.includes(v as Weekday);

/** The SimpleRule for an RRULE value, or null if it uses parts the editor doesn't support. */
export function simpleRuleFromRecur(
  recur: ICAL.Recur,
  displayTimeZone: string,
  untilTzid?: string | null,
): SimpleRule | null {
  if (!isFrequency(recur.freq)) return null;
  let byDay: Weekday[] = [];
  for (const [key, values] of Object.entries(recur.parts ?? {})) {
    if (!Array.isArray(values) || values.length === 0) continue;
    if (key === 'BYDAY' && recur.freq === 'WEEKLY' && values.every(isWeekday)) {
      byDay = WEEKDAYS.filter((d) => (values as string[]).includes(d));
    } else {
      return null;
    }
  }

  let end: RuleEnd = { type: 'never' };
  if (recur.count) end = { type: 'count', count: recur.count };
  else if (recur.until) {
    end = {
      type: 'until',
      date: recur.until.isDate
        ? dateString(recur.until)
        : instantToWall(timeToInstant(recur.until, untilTzid).date.getTime(), displayTimeZone).date,
    };
  }
  return { freq: recur.freq, interval: Math.max(1, recur.interval || 1), byDay, end };
}

/**
 * The UNTIL value for "ends on <date>": RFC 5545 wants a DATE for all-day series, UTC for zoned
 * ones and floating time for floating ones. Timed series run until the end of that day in the
 * display timezone.
 */
function untilTime(
  date: string,
  dtstart: ICAL.Time,
  startTzid: string | null,
  displayTimeZone: string,
): ICAL.Time {
  if (dtstart.isDate) return ICAL.Time.fromDateString(date);
  const floating = !startTzid && dtstart.zone !== ICAL.Timezone.utcTimezone;
  if (floating) return ICAL.Time.fromDateTimeString(`${date}T23:59:59`);
  const ms = wallToInstant(date, '23:59:59', displayTimeZone);
  return ICAL.Time.fromJSDate(new Date(ms), true);
}

export function recurFromSimpleRule(
  rule: SimpleRule,
  dtstart: ICAL.Time,
  startTzid: string | null,
  displayTimeZone: string,
): ICAL.Recur {
  const data: Parameters<typeof ICAL.Recur.fromData>[0] = {
    freq: rule.freq,
    interval: Math.max(1, Math.floor(rule.interval) || 1),
  };
  if (rule.freq === 'WEEKLY' && rule.byDay.length > 0) data.byday = [...rule.byDay];
  if (rule.end.type === 'count') data.count = Math.max(1, Math.floor(rule.end.count));
  if (rule.end.type === 'until') {
    data.until = untilTime(rule.end.date, dtstart, startTzid, displayTimeZone);
  }
  return ICAL.Recur.fromData(data);
}

export function rulesEqual(a: SimpleRule | null, b: SimpleRule | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const FREQ_UNITS: Record<Frequency, [string, string]> = {
  DAILY: ['day', 'days'],
  WEEKLY: ['week', 'weeks'],
  MONTHLY: ['month', 'months'],
  YEARLY: ['year', 'years'],
};

const WEEKDAY_NAMES: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

/** Human-readable summary, e.g. "Every 2 weeks on Mon, Wed, until 5 Mar 2026". */
export function describeRule(rule: SimpleRule): string {
  const [one, many] = FREQ_UNITS[rule.freq];
  let text = rule.interval === 1 ? `Every ${one}` : `Every ${rule.interval} ${many}`;
  if (rule.freq === 'WEEKLY' && rule.byDay.length > 0) {
    text += ` on ${rule.byDay.map((d) => WEEKDAY_NAMES[d]).join(', ')}`;
  }
  if (rule.end.type === 'count') text += `, ${rule.end.count} times`;
  if (rule.end.type === 'until') {
    const [y, m, d] = rule.end.date.split('-').map(Number);
    const label = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(
      undefined,
      { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
    );
    text += `, until ${label}`;
  }
  return text;
}
