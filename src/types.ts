import type ICAL from 'ical.js';

/** One .ics file from Drive. The parsed VCALENDAR is kept so unknown data round-trips. */
export interface CalendarFile {
  fileId: string;
  name: string;
  displayName: string;
  modifiedTime: string;
  vcalendar: ICAL.Component;
  dirty: boolean;
}

/** One displayable occurrence of an event (a recurring event yields one per occurrence). */
export interface AgendaEvent {
  /** Unique per occurrence: UID, plus the RECURRENCE-ID for recurring events. */
  id: string;
  uid: string;
  calendarFileId: string;
  /** SUMMARY, or "" when the event has none. */
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  /** True for occurrences of a series (RRULE/RDATE), including overridden ones. */
  recurring: boolean;
  /**
   * RECURRENCE-ID of this occurrence: set for occurrences of a series and for overrides whose
   * series is missing from the file.
   */
  recurrenceId?: ICAL.Time;
  /**
   * Start/end as FullCalendar inputs: "YYYY-MM-DD" for all-day, an ISO instant with "Z" for
   * zoned times, or a local "YYYY-MM-DDTHH:mm:ss" for floating times (shown as wall-clock time
   * in the display timezone).
   */
  startInput: string;
  endInput: string;
}

export interface DateRange {
  start: Date;
  end: Date;
}
