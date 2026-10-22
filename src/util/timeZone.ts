// Timezone helpers built on Intl, used for IANA zones that ical.js has no VTIMEZONE for and
// by the FullCalendar named-timezone plugin.

/** [year, month (0-11), day, hour, minute, second, millisecond] */
export type DateArray = number[];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Wall-clock fields of an instant in the given zone. */
export function epochToZonedArray(ms: number, timeZone: string): DateArray {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const millis = ((ms % 1000) + 1000) % 1000;
  return [
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    millis,
  ];
}

function arrayToUtcMs(a: DateArray): number {
  return Date.UTC(a[0] ?? 1970, a[1] ?? 0, a[2] ?? 1, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0, a[6] ?? 0);
}

/** UTC offset of the zone at the given instant, in minutes (e.g. +120 for Paris in summer). */
export function zoneOffsetMinutes(ms: number, timeZone: string): number {
  return Math.round((arrayToUtcMs(epochToZonedArray(ms, timeZone)) - ms) / 60_000);
}

/**
 * Converts wall-clock fields in a zone to an epoch instant. Times skipped by a DST gap resolve
 * forward; ambiguous times (DST overlap) resolve to the earlier offset's guess.
 */
export function zonedArrayToEpoch(a: DateArray, timeZone: string): number {
  const asUtc = arrayToUtcMs(a);
  const offset1 = zoneOffsetMinutes(asUtc, timeZone);
  const guess = asUtc - offset1 * 60_000;
  const offset2 = zoneOffsetMinutes(guess, timeZone);
  return offset1 === offset2 ? guess : asUtc - offset2 * 60_000;
}
