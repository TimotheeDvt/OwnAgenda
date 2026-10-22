import { epochToZonedArray, zonedArrayToEpoch } from './timeZone';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "YYYY-MM-DD" shifted by whole days (calendar arithmetic, no timezone involved). */
export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date: "${date}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Splits an instant into date ("YYYY-MM-DD") and time ("HH:mm") inputs in the given zone. */
export function instantToWall(ms: number, timeZone: string): { date: string; time: string } {
  const a = epochToZonedArray(ms, timeZone);
  return {
    date: `${pad(a[0] ?? 1970, 4)}-${pad((a[1] ?? 0) + 1)}-${pad(a[2] ?? 1)}`,
    time: `${pad(a[3] ?? 0)}:${pad(a[4] ?? 0)}`,
  };
}

/** Inverse of instantToWall: wall-clock date + time in the zone → epoch ms (NaN if invalid). */
export function wallToInstant(date: string, time: string, timeZone: string): number {
  const m = LOCAL_DATETIME_RE.exec(`${date}T${time}`);
  if (!m) return NaN;
  return zonedArrayToEpoch(
    [
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0),
      0,
    ],
    timeZone,
  );
}

/**
 * Converts an AgendaEvent start/end input to an ISO instant. Floating inputs (no "Z") are wall
 * times in the display zone, matching how they are shown.
 */
export function eventInputToIso(input: string, timeZone: string): string {
  if (input.endsWith('Z')) return input;
  const [date = '', time = ''] = input.split('T');
  return new Date(wallToInstant(date, time, timeZone)).toISOString();
}
