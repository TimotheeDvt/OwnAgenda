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
  effectiveTextColor,
  getCalendarSettings,
  getSettings,
  onSettingsChange,
  updateSettings,
  VIEW_NAMES,
  type ViewName,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { changeEventTimes, createEventAt, openEvent, type EventTimes } from './eventActions';
import { captureToClipboard } from './captureView';
import { ICONS } from './icons';
import intlTimeZonePlugin from './timeZonePlugin';

export interface CalendarView {
  today(): void;
  prev(): void;
  next(): void;
  changeView(view: ViewName): void;
  /** Navigates to the date of an event (e.g. a search result). */
  showEvent(event: AgendaEvent): void;
  /** Re-measures the calendar after its container changed size (e.g. sidebar resized). */
  updateSize(): void;
  destroy(): void;
}

/** Below this width the toolbar is split in two rows (Phase 4 mobile layout). */
export const NARROW_QUERY = '(max-width: 720px)';

const WIDE_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  // 'capture' (camera, only shown in list view — see CSS) sits just left of the view buttons.
  header: { left: 'prev,next today', center: 'title', right: `capture ${VIEW_NAMES.join(',')}` },
  footer: false,
};
const NARROW_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  header: { left: 'prev,next', center: 'title', right: 'today' },
  footer: { center: `capture ${VIEW_NAMES.join(',')}` },
};

function toEventInput(event: AgendaEvent, readOnly: boolean): EventInput {
  const settings = getCalendarSettings(event.calendarFileId, calendarIndex(event.calendarFileId));
  const { color, icon } = settings;
  const textColor = effectiveTextColor(settings);
  return {
    id: event.id,
    title: event.title || '(No title)',
    start: event.startInput,
    end: event.endInput,
    allDay: event.allDay,
    color,
    // Dark or white text, whichever reads best on the event's background.
    textColor,
    // Events of subscribed calendars are copies of an online calendar: no drag & drop.
    editable: !readOnly,
    classNames: event.recurring ? ['is-recurring'] : [],
    // The calendar icon is drawn by eventDidMount (see placeIcon).
    extendedProps: { agendaEvent: event, icon, textColor },
  };
}

/**
 * Adds the calendar's icon to a rendered event: in the top-right corner of event blocks (on the
 * line of the hours), or before the name where there is no such line (list view, month-view dots).
 */
function placeIcon(el: HTMLElement, icon: string | undefined, textColor?: string): void {
  if (!icon) return;
  const badge = document.createElement('span');
  badge.className = 'event-icon';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = icon;
  // In list view and month dots the name sits on the page background: keep the page color.
  const inline =
    el.querySelector('.fc-list-event-title') ??
    (el.classList.contains('fc-daygrid-dot-event') ? el.querySelector('.fc-event-title') : null);
  if (inline) {
    badge.classList.add('is-inline');
    inline.prepend(badge);
  } else {
    // On the event block: same color as the event's text (dark or white for contrast). The
    // badge sits outside the part FullCalendar colors, so it is set explicitly.
    if (textColor) badge.style.color = textColor;
    el.classList.add('has-icon');
    el.appendChild(badge);
  }
}

const LIST_REFRESH_MS = 60_000;

/** Events that haven't ended yet (ongoing or future). */
function upcomingOnly(events: AgendaEvent[], now: Date): AgendaEvent[] {
  return events.filter((e) => e.end.getTime() > now.getTime());
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
  /** Copies the view (the grid, like a screenshot of it) to the clipboard, without the button. */
  const captureView = () => {
    const view = host.querySelector<HTMLElement>('.fc-view-harness');
    if (view) captureToClipboard(view, { exclude: (node) => node === captureCorner });
  };

  // Camera button in the grid's empty top-left cell (above "Full day", left of Monday). In list
  // view, which has no such cell, the toolbar's camera button is shown instead (CSS).
  const captureCorner = document.createElement('button');
  captureCorner.type = 'button';
  captureCorner.className = 'icon-btn capture-corner';
  captureCorner.innerHTML = ICONS.camera;
  captureCorner.title = 'Copy the calendar view as an image';
  captureCorner.setAttribute('aria-label', 'Copy the calendar view as an image');
  captureCorner.addEventListener('click', captureView);
  const placeCaptureCorner = () => {
    const harness = host.querySelector('.fc-view-harness');
    if (harness && captureCorner.parentElement !== harness) harness.appendChild(captureCorner);
  };

  const initial = getSettings();
  const narrow = window.matchMedia(NARROW_QUERY);
  const toolbar = () => (narrow.matches ? NARROW_TOOLBAR : WIDE_TOOLBAR);

  // The view type as of the last datesSet (FullCalendar loads events before `calendar` exists).
  let currentView: string = initial.defaultView;
  const calendar = new Calendar(host, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, intlTimeZonePlugin],
    initialView: initial.defaultView,
    firstDay: initial.weekStartsOn,
    timeZone: initial.timeZone,
    headerToolbar: toolbar().header,
    footerToolbar: toolbar().footer,
    buttonText: { today: 'Today', month: 'Month', week: 'Week', day: 'Day', list: 'List' },
    customButtons: {
      // Camera icon (CSS); copies the view, like a screenshot of it, to the clipboard.
      capture: {
        text: '',
        hint: 'Copy the calendar view as an image',
        click: () => captureView(),
      },
    },
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
      let events = eventsInRange(
        { start: info.start, end: info.end },
        (cal) => getCalendarSettings(cal.fileId, calendarIndex(cal.fileId)).visible,
      );
      // The list is an agenda of what's ahead: hide events that are already over (ongoing ones
      // stay, and full-day events stay until the day ends).
      if (currentView.startsWith('list')) events = upcomingOnly(events, new Date());
      const subscribed = new Set(
        getCalendarState()
          .calendars.filter((c) => subscriptionOf(c.fileId))
          .map((c) => c.fileId),
      );
      // Offline / session expired: nothing can be dragged or resized.
      const readOnly = getCalendarState().readOnly !== null;
      success(events.map((e) => toEventInput(e, readOnly || subscribed.has(e.calendarFileId))));
    },
    eventDidMount: (info) => {
      const agendaEvent = agendaEventOf(info.event);
      if (agendaEvent) info.el.title = tooltip(agendaEvent);
      const { icon, textColor } = info.event.extendedProps as { icon?: string; textColor?: string };
      placeIcon(info.el, icon, textColor);
    },
    datesSet: (arg) => {
      placeCaptureCorner();
      const view = arg.view.type as ViewName;
      // Same dates in another view reuse the loaded events; reload so the list view can leave
      // out past events (and other views show them again).
      if (view !== currentView) {
        currentView = view;
        queueMicrotask(() => calendar.refetchEvents());
      }
      if (VIEW_NAMES.includes(view) && view !== getSettings().defaultView) {
        updateSettings({ defaultView: view });
      }
    },
  });
  calendar.render();
  placeCaptureCorner();

  // In list view, drop events from the list as they end while the app stays open.
  const listRefresh = setInterval(() => {
    if (calendar.view.type.startsWith('list')) calendar.refetchEvents();
  }, LIST_REFRESH_MS);

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
  let lastReadOnly = getCalendarState().readOnly;
  const applyReadOnly = (readOnly: boolean) => {
    // No selecting a range to create an event while nothing can be saved.
    calendar.setOption('selectable', !readOnly);
    host.classList.toggle('is-read-only', readOnly);
  };
  applyReadOnly(lastReadOnly !== null);
  const offCalendars = onCalendarsChange((state) => {
    // Save-status updates don't change events; only refetch when calendar data or the
    // read-only mode changed.
    if (state.calendars === lastCalendars && state.readOnly === lastReadOnly) return;
    if (state.readOnly !== lastReadOnly) applyReadOnly(state.readOnly !== null);
    lastCalendars = state.calendars;
    lastReadOnly = state.readOnly;
    calendar.refetchEvents();
  });

  return {
    today: () => calendar.today(),
    prev: () => calendar.prev(),
    next: () => calendar.next(),
    changeView: (view) => calendar.changeView(view),
    showEvent: (event) => calendar.gotoDate(event.startInput),
    updateSize: () => calendar.updateSize(),
    destroy() {
      clearInterval(listRefresh);
      narrow.removeEventListener('change', onResize);
      offSettings();
      offCalendars();
      calendar.destroy();
    },
  };
}
