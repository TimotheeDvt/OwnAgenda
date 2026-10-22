import type { EventDraft } from '../ics/edit';
import {
  addEvent,
  calendarIndex,
  deleteEvent,
  editEvent,
  errorMessage,
  getCalendarState,
} from '../store/calendarStore';
import { getCalendarSettings, getSettings } from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { eventInputToIso } from '../util/dates';
import { openEventDialog, type CalendarOption } from './eventDialog';
import { showToast } from './toast';

/** New start/end of an event, in EventDraft format (dates for all-day, ISO instants otherwise). */
export type EventTimes = Pick<EventDraft, 'allDay' | 'start' | 'end'>;

function calendarOptions(): CalendarOption[] {
  return getCalendarState().calendars.map(({ fileId, displayName }) => ({ fileId, displayName }));
}

function run(action: () => void): boolean {
  try {
    action();
    return true;
  } catch (err) {
    showToast(errorMessage(err), 'error');
    return false;
  }
}

function eventToDraft(event: AgendaEvent): EventDraft {
  const { timeZone } = getSettings();
  return {
    title: event.title,
    allDay: event.allDay,
    start: event.allDay ? event.startInput : eventInputToIso(event.startInput, timeZone),
    end: event.allDay ? event.endInput : eventInputToIso(event.endInput, timeZone),
    location: event.location,
    description: event.description,
  };
}

/** Opens the dialog for a new event over the selected range. */
export async function createEventAt(times: EventTimes): Promise<void> {
  const calendars = calendarOptions();
  if (calendars.length === 0) {
    showToast('There is no calendar to add the event to. Add an .ics file to your folder first.');
    return;
  }
  const firstVisible = calendars.find(
    (c) => getCalendarSettings(c.fileId, calendarIndex(c.fileId)).visible,
  );
  const result = await openEventDialog({
    mode: 'create',
    calendars,
    calendarFileId: (firstVisible ?? calendars[0]!).fileId,
    draft: { title: '', ...times },
    timeZone: getSettings().timeZone,
  });
  if (result?.action === 'save') run(() => addEvent(result.calendarFileId, result.draft));
}

/** Opens the dialog for an existing event (read-only for recurring events). */
export async function openEvent(event: AgendaEvent): Promise<void> {
  const result = await openEventDialog({
    mode: 'edit',
    readOnly: event.recurring,
    calendars: calendarOptions(),
    calendarFileId: event.calendarFileId,
    draft: eventToDraft(event),
    timeZone: getSettings().timeZone,
  });
  if (!result) return;
  if (result.action === 'delete') {
    if (run(() => deleteEvent(event.calendarFileId, event.uid))) showToast('Event deleted.');
  } else {
    run(() => editEvent(event.calendarFileId, event.uid, result.draft, result.calendarFileId));
  }
}

/** Applies a drag & drop move or a resize. Returns false if it failed (the caller reverts). */
export function changeEventTimes(event: AgendaEvent, times: EventTimes): boolean {
  return run(() =>
    editEvent(event.calendarFileId, event.uid, { ...eventToDraft(event), ...times }),
  );
}
