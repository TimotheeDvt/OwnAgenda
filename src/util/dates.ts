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

/** Whole days from `b` to `a`, both "YYYY-MM-DD". */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Parses a 24-hour time typed by the user ("9", "930", "9:30", "09:30", "18.15") into "HH:mm".
 * Returns null if it isn't a valid time.
 */
export function normalizeTime(value: string): string | null {
  const v = value.trim();
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?$/.exec(v);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
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
