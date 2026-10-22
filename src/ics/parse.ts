import ICAL from 'ical.js';
import type { CalendarFile } from '../types';

export class IcsParseError extends Error {
  override name = 'IcsParseError';
}

/**
 * Registers every VTIMEZONE of the calendar with ical.js's TimezoneService, so times that
 * reference a TZID (including in other files) can be converted to absolute instants.
 */
export function registerTimezones(vcalendar: ICAL.Component): void {
  for (const vtz of vcalendar.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || ICAL.TimezoneService.has(tzid)) continue;
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: vtz, tzid }));
  }
}

/** Parses .ics text into its root VCALENDAR component and registers its timezones. */
export function parseIcs(text: string): ICAL.Component {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(text);
  } catch (err) {
    throw new IcsParseError(`Invalid iCalendar data: ${(err as Error).message}`);
  }
  // ICAL.parse returns an array of components when the text has several top-level ones.
  const roots = (Array.isArray(jcal) && Array.isArray(jcal[0]) ? jcal : [jcal]) as unknown[];
  for (const root of roots) {
    const component = new ICAL.Component(root as ConstructorParameters<typeof ICAL.Component>[0]);
    if (component.name === 'vcalendar') {
      registerTimezones(component);
      return component;
    }
  }
  throw new IcsParseError('No VCALENDAR found in file.');
}

/** X-WR-CALNAME if present, otherwise the file name without its .ics extension. */
export function calendarDisplayName(vcalendar: ICAL.Component, fileName: string): string {
  const calName = vcalendar.getFirstPropertyValue('x-wr-calname');
  if (typeof calName === 'string' && calName.trim()) return calName.trim();
  return fileName.replace(/\.ics$/i, '');
}

export function toCalendarFile(
  meta: { id: string; name: string; modifiedTime: string },
  text: string,
): CalendarFile {
  const vcalendar = parseIcs(text);
  return {
    fileId: meta.id,
    name: meta.name,
    displayName: calendarDisplayName(vcalendar, meta.name),
    modifiedTime: meta.modifiedTime,
    vcalendar,
    dirty: false,
  };
}
