import { Calendar, type EventApi, type EventInput } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid';
import {
  calendarIndex,
  eventsInRange,
  getCalendarState,
  onCalendarsChange,
} from '../store/calendarStore';
import {
  getCalendarSettings,
  getSettings,
  onSettingsChange,
  updateSettings,
  VIEW_NAMES,
  type ViewName,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { changeEventTimes, createEventAt, openEvent, type EventTimes } from './eventActions';
import intlTimeZonePlugin from './timeZonePlugin';

export interface CalendarView {
  destroy(): void;
}

function toEventInput(event: AgendaEvent): EventInput {
  const { color } = getCalendarSettings(event.calendarFileId, calendarIndex(event.calendarFileId));
  return {
    id: event.id,
    title: event.title || '(No title)',
    start: event.startInput,
    end: event.endInput,
    allDay: event.allDay,
    color,
    // Recurring events become editable in a later phase.
    editable: !event.recurring,
    extendedProps: { agendaEvent: event },
  };
}

function tooltip(event: AgendaEvent): string {
  return [event.title || '(No title)', event.location, event.description]
    .filter(Boolean)
    .join('\n');
}

function agendaEventOf(event: EventApi): AgendaEvent | undefined {
  return event.extendedProps.agendaEvent as AgendaEvent | undefined;
}

/** New times of a dragged/resized event (forceEventDuration guarantees an end). */
function timesOf(event: EventApi): EventTimes | null {
  if (!event.start || !event.end) return null;
  return event.allDay
    ? { allDay: true, start: event.startStr.slice(0, 10), end: event.endStr.slice(0, 10) }
    : { allDay: false, start: event.start.toISOString(), end: event.end.toISOString() };
}

export function mountCalendarView(host: HTMLElement): CalendarView {
  const initial = getSettings();
  const calendar = new Calendar(host, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, intlTimeZonePlugin],
    initialView: initial.defaultView,
    firstDay: initial.weekStartsOn,
    timeZone: initial.timeZone,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: VIEW_NAMES.join(','),
    },
    buttonText: { today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'List' },
    height: '100%',
    nowIndicator: true,
    dayMaxEvents: true,
    editable: true,
    selectable: true,
    selectMirror: true,
    forceEventDuration: true,
    select: (info) => {
      calendar.unselect();
      void createEventAt(
        info.allDay
          ? { allDay: true, start: info.startStr.slice(0, 10), end: info.endStr.slice(0, 10) }
          : { allDay: false, start: info.start.toISOString(), end: info.end.toISOString() },
      );
    },
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      const agendaEvent = agendaEventOf(info.event);
      if (agendaEvent) void openEvent(agendaEvent);
    },
    eventChange: (info) => {
      const agendaEvent = agendaEventOf(info.event);
      const times = timesOf(info.event);
      if (!agendaEvent || !times || !changeEventTimes(agendaEvent, times)) info.revert();
    },
    events: (info, success) => {
      const events = eventsInRange(
        { start: info.start, end: info.end },
        (cal) => getCalendarSettings(cal.fileId, calendarIndex(cal.fileId)).visible,
      );
      success(events.map(toEventInput));
    },
    eventDidMount: (info) => {
      const agendaEvent = agendaEventOf(info.event);
      if (agendaEvent) info.el.title = tooltip(agendaEvent);
    },
    datesSet: (arg) => {
      const view = arg.view.type as ViewName;
      if (VIEW_NAMES.includes(view) && view !== getSettings().defaultView) {
        updateSettings({ defaultView: view });
      }
    },
  });
  calendar.render();

  let last = initial;
  const offSettings = onSettingsChange((s) => {
    if (s.timeZone !== last.timeZone) calendar.setOption('timeZone', s.timeZone);
    if (s.weekStartsOn !== last.weekStartsOn) calendar.setOption('firstDay', s.weekStartsOn);
    // Colors and visibility only affect events.
    if (s.calendars !== last.calendars) calendar.refetchEvents();
    last = s;
  });
  let lastCalendars = getCalendarState().calendars;
  const offCalendars = onCalendarsChange((state) => {
    // Save-status updates don't change events; only refetch when calendar data changed.
    if (state.calendars === lastCalendars) return;
    lastCalendars = state.calendars;
    calendar.refetchEvents();
  });

  return {
    destroy() {
      offSettings();
      offCalendars();
      calendar.destroy();
    },
  };
}
