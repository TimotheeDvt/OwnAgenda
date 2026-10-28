import {
  Calendar,
  type DayHeaderContentArg,
  type EventApi,
  type EventInput,
  type ToolbarInput,
} from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid';
import {
  calendarIndex,
  eventsInRange,
  getCalendarState,
  getHistory,
  onCalendarsChange,
  onHistoryChange,
  subscriptionOf,
} from '../store/calendarStore';
import { isGhostEvent } from '../store/ghostEvents';
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
import { isoWeek } from '../util/dates';
import {
  changeEventTimes,
  createEventAt,
  openEvent,
  openEventMenu,
  redoLastChange,
  undoLastChange,
  type EventTimes,
} from './eventActions';
import { captureToClipboard } from './captureView';
import { openViewMenu } from './viewMenu';
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

/** One button per view on computers; phones get every view (3 days too) in a menu. */
const WIDE_VIEW_BUTTONS: ViewName[] = [
  'dayGridMonth',
  'dayGridThreeWeek',
  'timeGridWeek',
  'timeGridDay',
  'listWeek',
];

/** Menu labels, and the short names used in the URL. */
const VIEWS: Record<ViewName, { label: string; url: string }> = {
  dayGridMonth: { label: 'Month', url: 'month' },
  dayGridThreeWeek: { label: 'Two weeks', url: '2weeks' },
  timeGridWeek: { label: 'Week', url: 'week' },
  timeGrid3Day: { label: '3 days', url: '3days' },
  timeGridDay: { label: 'Day', url: 'day' },
  listWeek: { label: 'List', url: 'list' },
};

const WIDE_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  // 'capture' (camera) sits just left of the view buttons.
  header: {
    left: 'today prev,next undo,redo',
    center: 'title',
    right: `ghosts capture ${WIDE_VIEW_BUTTONS.join(',')}`,
  },
  footer: false,
};
const NARROW_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  header: { left: 'today prev,next', center: 'title', right: '' },
  // Undo/redo at the bottom, within reach of the thumb; the views in a menu (see openViewMenu).
  footer: { center: 'undo,redo ghosts capture viewMenu' },
};

// 24-hour clock on the time axis; just the hour on phones, so the day columns get the width.
const WIDE_SLOT_LABEL = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
const NARROW_SLOT_LABEL = { hour: '2-digit', hour12: false } as const;

/**
 * Column headers: "22 Thursday" in week/day views (day of the month in bold), "Thursday" in
 * month view. Both weekday names are rendered; CSS shows the long one only where it fits.
 */
function dayHeaderContent(arg: DayHeaderContentArg) {
  // List view: FullCalendar's own day rows (full date); week numbers added by syncListWeekNumbers.
  if (arg.view.type.startsWith('list')) return true;
  // Formatted by the calendar so the date is read in its time zone, not the browser's.
  const format = (options: Intl.DateTimeFormatOptions) =>
    arg.view.calendar.formatDate(arg.date, options);
  const label = document.createElement('span');
  label.className = 'day-header-label';
  if (arg.view.type.startsWith('timeGrid')) {
    const day = document.createElement('b');
    day.textContent = format({ day: '2-digit' });
    label.append(day, ' ');
  }
  const long = document.createElement('span');
  long.className = 'weekday-long';
  long.textContent = format({ weekday: 'long' });
  const short = document.createElement('span');
  short.className = 'weekday-short';
  short.textContent = format({ weekday: 'short' });
  label.append(long, short);
  return { domNodes: [label] };
}

/**
 * `ghostsInBackground` (week/day views): timed ghost events are drawn as background events, so
 * they don't take a column and push the real events aside when they overlap.
 */
function toEventInput(
  event: AgendaEvent,
  readOnly: boolean,
  ghostsInBackground: boolean,
): EventInput {
  const ghost = isGhostEvent(event);
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
    classNames: [...(event.recurring ? ['is-recurring'] : []), ...(ghost ? ['is-ghost'] : [])],
    display: ghost && ghostsInBackground && !event.allDay ? 'background' : 'auto',
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

/** "43": the same small pill in every view (see .week-number). */
function weekNumberBadge(week: number): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'week-number';
  badge.textContent = String(week);
  badge.title = `Week ${week}`;
  return badge;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The view and date kept in the URL (?view=week&date=YYYY-MM-DD), so a reload stays there. */
function readUrlPosition(): { view?: ViewName; date?: string } {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('view');
  const date = params.get('date');
  return {
    view: VIEW_NAMES.find((v) => VIEWS[v].url === name),
    date: date && ISO_DATE.test(date) && !Number.isNaN(Date.parse(date)) ? date : undefined,
  };
}

/** Updates the URL in place (no new history entry for every period browsed). */
function writeUrlPosition(view: ViewName, date: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('view', VIEWS[view].url);
  url.searchParams.set('date', date);
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
}

/** A horizontal swipe at least this long (px) and this quick (ms) changes the period. */
const SWIPE_MIN_PX = 60;
const SWIPE_MAX_MS = 600;

/**
 * Swipe left/right on touch screens to go to the next/previous period (day, week, month). Mostly
 * horizontal, quick swipes only, so vertical scrolling and long-press drags aren't mistaken for one.
 */
function listenForSwipes(
  host: HTMLElement,
  isBusy: () => boolean,
  go: (direction: 'prev' | 'next') => void,
): () => void {
  let start: { x: number; y: number; time: number } | null = null;
  const onStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    // Pinch zoom and other multi-finger gestures aren't swipes.
    start =
      e.touches.length === 1 && touch
        ? { x: touch.clientX, y: touch.clientY, time: e.timeStamp }
        : null;
  };
  const onEnd = (e: TouchEvent) => {
    const touch = e.changedTouches[0];
    if (!start || !touch || isBusy()) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const quick = e.timeStamp - start.time <= SWIPE_MAX_MS;
    start = null;
    if (quick && Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
      go(dx < 0 ? 'next' : 'prev');
    }
  };
  const onCancel = () => {
    start = null;
  };
  host.addEventListener('touchstart', onStart, { passive: true });
  host.addEventListener('touchend', onEnd, { passive: true });
  host.addEventListener('touchcancel', onCancel, { passive: true });
  return () => {
    host.removeEventListener('touchstart', onStart);
    host.removeEventListener('touchend', onEnd);
    host.removeEventListener('touchcancel', onCancel);
  };
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
  /** Copies the view (the grid, like a screenshot of it) to the clipboard. */
  const captureView = () => {
    const view = host.querySelector<HTMLElement>('.fc-view-harness');
    if (view) captureToClipboard(view);
  };

  const initial = getSettings();
  const narrow = window.matchMedia(NARROW_QUERY);
  const toolbar = () => (narrow.matches ? NARROW_TOOLBAR : WIDE_TOOLBAR);
  const slotLabelFormat = () => (narrow.matches ? NARROW_SLOT_LABEL : WIDE_SLOT_LABEL);

  // An event being dragged or resized: the finger moving is not a swipe.
  let dragging = false;
  // The view type as of the last datesSet (FullCalendar loads events before `calendar` exists).
  const fromUrl = readUrlPosition();
  let currentView: string = fromUrl.view ?? initial.defaultView;
  const calendar = new Calendar(host, {
    plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, intlTimeZonePlugin],
    initialView: currentView,
    // Reloading the page stays on the period that was shown (see writeUrlPosition).
    ...(fromUrl.date ? { initialDate: fromUrl.date } : {}),
    // English with day-before-month dates (e.g. titles: "20 – 26 Oct 2026").
    locale: 'en-GB',
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
      // Ghost icon (CSS), crossed out while ghosts are hidden (see syncGhostsButton).
      ghosts: {
        text: '',
        hint: 'Hide all ghosts',
        click: () => updateSettings({ showGhosts: !getSettings().showGhosts }),
      },
      // Arrow icons (CSS); disabled when there is nothing to undo/redo (see updateHistoryButtons).
      undo: { text: '', hint: 'Undo', click: () => undoLastChange() },
      redo: { text: '', hint: 'Redo', click: () => redoLastChange() },
      // Phones: the current view's name, opening the list of views (see syncViewMenuButton).
      viewMenu: {
        text: 'View',
        hint: 'Change view',
        click: (e) =>
          openViewMenu(e.currentTarget as HTMLElement, {
            current: calendar.view.type,
            views: VIEW_NAMES.map((view) => ({ view, label: VIEWS[view].label })),
            onPick: (view) => calendar.changeView(view),
          }),
      },
    },
    views: {
      // Two rows of seven days, like the month grid; just the event names (no times).
      dayGridThreeWeek: {
        type: 'dayGrid',
        duration: { weeks: 3 },
        buttonText: '3 weeks',
        displayEventTime: false,
      },
      timeGrid3Day: { type: 'timeGrid', duration: { days: 3 } },
    },
    // No label next to the all-day row.
    allDayText: '',
    dayHeaderContent,
    // Week numbers (ISO, "43"): on each row in month view, in the top-left corner in week/day
    // views. List view has none built in: see syncListWeekNumbers.
    weekNumbers: true,
    weekNumberCalculation: 'ISO',
    weekNumberContent: ({ num }) => ({ domNodes: [weekNumberBadge(num)] }),
    eventsSet: () => requestAnimationFrame(syncListWeekNumbers),
    // 24-hour clock everywhere (time axis, event times, list view).
    slotLabelFormat: slotLabelFormat(),
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
    // Cleared after the touchend of the drag itself has been handled (not a swipe either).
    eventDragStart: () => (dragging = true),
    eventDragStop: () => setTimeout(() => (dragging = false)),
    eventResizeStart: () => (dragging = true),
    eventResizeStop: () => setTimeout(() => (dragging = false)),
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
      if (!getSettings().showGhosts) events = events.filter((e) => !isGhostEvent(e));
      const subscribed = new Set(
        getCalendarState()
          .calendars.filter((c) => subscriptionOf(c.fileId))
          .map((c) => c.fileId),
      );
      // Offline / session expired: nothing can be dragged or resized.
      const readOnly = getCalendarState().readOnly !== null;
      const ghostsInBackground = currentView.startsWith('timeGrid');
      success(
        events.map((e) =>
          toEventInput(e, readOnly || subscribed.has(e.calendarFileId), ghostsInBackground),
        ),
      );
    },
    eventDidMount: (info) => {
      const agendaEvent = agendaEventOf(info.event);
      if (agendaEvent) info.el.title = tooltip(agendaEvent);
      const { icon, textColor } = info.event.extendedProps as { icon?: string; textColor?: string };
      placeIcon(info.el, icon, textColor);
      // Background (ghost) events get no eventClick: open them here. Stopping mousedown keeps
      // a click on them from starting a "new event" selection (touch selects on long press only).
      if (info.event.display === 'background' && agendaEvent) {
        info.el.addEventListener('mousedown', (e) => e.stopPropagation());
        info.el.addEventListener('click', () => void openEvent(agendaEvent));
      }
      // Right click (or the menu key / Shift+F10 on a focused event): the event's menu. Not on
      // touch screens, where a long press drags the event.
      if (agendaEvent) {
        info.el.addEventListener('contextmenu', (e) => {
          if ((e as PointerEvent).pointerType === 'touch') return;
          e.preventDefault();
          // From the keyboard there is no pointer position: open below the event's top-left.
          const keyboard = e.clientX === 0 && e.clientY === 0;
          const rect = info.el.getBoundingClientRect();
          openEventMenu(
            agendaEvent,
            keyboard ? rect.left + 8 : e.clientX,
            keyboard ? rect.top + 20 : e.clientY,
          );
        });
      }
    },
    datesSet: (arg) => {
      requestAnimationFrame(syncListWeekNumbers);
      updateHistoryButtons();
      syncViewMenuButton();
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
      // The first day shown, in the calendar's time zone.
      writeUrlPosition(view, calendar.formatIso(arg.view.currentStart, true).slice(0, 10));
    },
  });
  calendar.render();

  /** List view: "43" at the left of the first row of each week (rows are only days with events). */
  function syncListWeekNumbers(): void {
    host.querySelectorAll('.list-week-number').forEach((el) => el.remove());
    if (!calendar.view.type.startsWith('list')) return;
    let lastWeek = -1;
    for (const row of host.querySelectorAll<HTMLElement>('.fc-list-day')) {
      const date = row.dataset.date;
      if (!date) continue;
      const week = isoWeek(date);
      if (week === lastWeek) continue;
      lastWeek = week;
      const badge = weekNumberBadge(week);
      badge.classList.add('list-week-number');
      row.querySelector('.fc-list-day-cushion')?.prepend(badge);
    }
  }

  /** The phone view menu button shows the current view's name (and ▾). */
  function syncViewMenuButton(): void {
    const btn = host.querySelector<HTMLButtonElement>('.fc-viewMenu-button');
    if (!btn) return;
    const view = calendar.view.type as ViewName;
    btn.textContent = `${VIEWS[view]?.label ?? 'View'} ▾`;
    btn.setAttribute('aria-haspopup', 'menu');
  }

  /** The ghosts button: pressed (crossed out) while ghosts are hidden. */
  function syncGhostsButton(): void {
    const shown = getSettings().showGhosts;
    for (const button of host.querySelectorAll<HTMLButtonElement>('.fc-ghosts-button')) {
      button.title = shown ? 'Hide all ghosts' : 'Show all ghosts';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(!shown));
    }
  }
  syncGhostsButton();

  /** Enables undo/redo only when there is something to undo/redo and changes can be saved. */
  function updateHistoryButtons(): void {
    const history = getHistory();
    const readOnly = getCalendarState().readOnly !== null;
    for (const [name, label] of [
      ['undo', history.undo],
      ['redo', history.redo],
    ] as const) {
      const hint = name === 'undo' ? 'Undo' : 'Redo';
      for (const button of host.querySelectorAll<HTMLButtonElement>(`.fc-${name}-button`)) {
        button.disabled = !label || readOnly;
        button.title = label ? `${hint}: ${label}` : hint;
        button.setAttribute('aria-label', button.title);
      }
    }
  }
  updateHistoryButtons();
  const offHistory = onHistoryChange(updateHistoryButtons);

  // In list view, drop events from the list as they end while the app stays open.
  const offSwipes = listenForSwipes(
    host,
    // Not while dragging an event, nor with the "+N more" popover open.
    () => dragging || host.querySelector('.fc-popover') !== null,
    (direction) => (direction === 'next' ? calendar.next() : calendar.prev()),
  );

  const listRefresh = setInterval(() => {
    if (calendar.view.type.startsWith('list')) calendar.refetchEvents();
  }, LIST_REFRESH_MS);

  const onResize = () => {
    calendar.setOption('headerToolbar', toolbar().header);
    calendar.setOption('footerToolbar', toolbar().footer);
    calendar.setOption('slotLabelFormat', slotLabelFormat());
    // The toolbars were rebuilt.
    updateHistoryButtons();
    syncGhostsButton();
    syncViewMenuButton();
  };
  narrow.addEventListener('change', onResize);

  let last = initial;
  const offSettings = onSettingsChange((s) => {
    if (s.timeZone !== last.timeZone) calendar.setOption('timeZone', s.timeZone);
    if (s.weekStartsOn !== last.weekStartsOn) calendar.setOption('firstDay', s.weekStartsOn);
    // Colors, visibility and ghosts only affect events.
    if (
      s.calendars !== last.calendars ||
      s.ghostEvents !== last.ghostEvents ||
      s.showGhosts !== last.showGhosts
    ) {
      calendar.refetchEvents();
    }
    if (s.showGhosts !== last.showGhosts) syncGhostsButton();
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
    if (state.readOnly !== lastReadOnly) {
      applyReadOnly(state.readOnly !== null);
      updateHistoryButtons();
    }
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
      offSwipes();
      offHistory();
      narrow.removeEventListener('change', onResize);
      offSettings();
      offCalendars();
      calendar.destroy();
    },
  };
}
