import { Calendar, type EventApi, type EventInput, type ToolbarInput } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid';
import {
  calendarIndex,
  eventsInRange,
  getCalendarState,
  onCalendarsChange,
  subscriptionOf,
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
  today(): void;
  prev(): void;
  next(): void;
  changeView(view: ViewName): void;
  /** Navigates to the date of an event (e.g. a search result). */
  showEvent(event: AgendaEvent): void;
  destroy(): void;
}

/** Below this width the toolbar is split in two rows (Phase 4 mobile layout). */
export const NARROW_QUERY = '(max-width: 720px)';

const WIDE_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  header: { left: 'prev,next today', center: 'title', right: VIEW_NAMES.join(',') },
  footer: false,
};
const NARROW_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  header: { left: 'prev,next', center: 'title', right: 'today' },
  footer: { center: VIEW_NAMES.join(',') },
};

function toEventInput(event: AgendaEvent, readOnly: boolean): EventInput {
  const { color } = getCalendarSettings(event.calendarFileId, calendarIndex(event.calendarFileId));
  return {
    id: event.id,
    title: event.title || '(No title)',
    start: event.startInput,
    end: event.endInput,
    allDay: event.allDay,
    color,
    // Events of subscribed calendars are copies of an online calendar: no drag & drop.
    editable: !readOnly,
    classNames: event.recurring ? ['is-recurring'] : [],
    extendedProps: { agendaEvent: event },
  };
}

function tooltip(event: AgendaEvent): string {
  return [
    event.title || '(No title)',
    event.recurring ? '↻ Repeating event' : '',
    event.location,
    event.description,
  ]
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
  const narrow = window.matchMedia(NARROW_QUERY);
  const toolbar = () => (narrow.matches ? NARROW_TOOLBAR : WIDE_TOOLBAR);

  const calendar = new Calendar(host, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, intlTimeZonePlugin],
    initialView: initial.defaultView,
    firstDay: initial.weekStartsOn,
    timeZone: initial.timeZone,
    headerToolbar: toolbar().header,
    footerToolbar: toolbar().footer,
    buttonText: { today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'List' },
    allDayText: 'Full day',
    // 24-hour clock everywhere (time axis, event times, list view).
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    height: '100%',
    nowIndicator: true,
    dayMaxEvents: true,
    editable: true,
    selectable: true,
    selectMirror: true,
    // Long-press to drag on touch screens, short enough to feel responsive.
    longPressDelay: 400,
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
      if (!agendaEvent || !times) {
        info.revert();
        return;
      }
      void changeEventTimes(agendaEvent, times).then((ok) => {
        if (!ok) info.revert();
      });
    },
    events: (info, success) => {
      const events = eventsInRange(
        { start: info.start, end: info.end },
        (cal) => getCalendarSettings(cal.fileId, calendarIndex(cal.fileId)).visible,
      );
      const subscribed = new Set(
        getCalendarState()
          .calendars.filter((c) => subscriptionOf(c.fileId))
          .map((c) => c.fileId),
      );
      success(events.map((e) => toEventInput(e, subscribed.has(e.calendarFileId))));
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

  const onResize = () => {
    calendar.setOption('headerToolbar', toolbar().header);
    calendar.setOption('footerToolbar', toolbar().footer);
  };
  narrow.addEventListener('change', onResize);

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
    today: () => calendar.today(),
    prev: () => calendar.prev(),
    next: () => calendar.next(),
    changeView: (view) => calendar.changeView(view),
    showEvent: (event) => calendar.gotoDate(event.startInput),
    destroy() {
      narrow.removeEventListener('change', onResize);
      offSettings();
      offCalendars();
      calendar.destroy();
    },
  };
}
