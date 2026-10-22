import type ICAL from 'ical.js';

/**
 * Serializes the VCALENDAR back to .ics text. ical.js writes every property and subcomponent it
 * parsed (alarms, attendees, X- properties...), with CRLF line endings and folded long lines.
 */
export function serializeCalendar(vcalendar: ICAL.Component): string {
  const text = vcalendar.toString();
  return text.endsWith('\r\n') ? text : `${text}\r\n`;
}
