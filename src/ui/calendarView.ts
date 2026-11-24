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
import multiMonthPlugin from '@fullcalendar/multimonth';
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
import { isGhostEvent, setGhostEvent } from '../store/ghostEvents';
import {
  effectiveTextColor,
  getCalendarSettings,
  getSettings,
  isListView,
  onSettingsChange,
  SPAN_NAMES,
  SPAN_VIEWS,
  spanOf,
  updateSettings,
  VIEW_NAMES,
  viewFor,
  type SpanName,
  type ViewName,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { isHardOnDark } from '../util/color';
import { instantToWall, isoWeek } from '../util/dates';
import { eventDays } from '../util/dotDays';
import {
  changeEventTimes,
  copyEventTo,
  createEventAt,
  openEvent,
  openEventMenu,
  openSlotMenu,
  redoLastChange,
  undoLastChange,
  type EventTimes,
} from './eventActions';
import {
  attachEventTooltip,
  detachEventTooltip,
  eventListTooltipContent,
  eventTooltipContent,
} from './eventTooltip';
import { captureToClipboard } from './captureView';
import { openMonthPicker } from './monthPicker';
import { openViewMenu } from './viewMenu';
import intlTimeZonePlugin from './timeZonePlugin';

export interface CalendarView {
  today(): void;
  prev(): void;
  next(): void;
  /** Another time span, in the current layout (grid or list). */
  changeSpan(span: SpanName): void;
  /** Shows the current time span as a list if it is a grid, and the other way round. */
  toggleLayout(): void;
  /** Navigates to the date of an event (e.g. a search result). */
  showEvent(event: AgendaEvent): void;
  /** Re-measures the calendar after its container changed size (e.g. sidebar resized). */
  updateSize(): void;
  destroy(): void;
}

/** Below this width the toolbar is split in two rows (Phase 4 mobile layout). */
export const NARROW_QUERY = '(max-width: 720px)';

/** Time spans: one button each on computers; phones get every span (3 days too) in a menu. */
const SPAN_LABELS: Record<SpanName, string> = {
  year: 'Year',
  month: 'Month',
  '3weeks': '3 weeks',
  week: 'Week',
  '3days': '3 days',
  day: 'Day',
};
const WIDE_SPANS: SpanName[] = ['year', 'month', '3weeks', 'week', 'day'];
const spanButton = (span: SpanName) => `span-${span}`;

/** The short names used in the URL (?view=week, ?view=list-week; "list" alone = list-week). */
const VIEW_URLS: Record<ViewName, string> = Object.fromEntries(
  SPAN_NAMES.flatMap((span) => [
    [SPAN_VIEWS[span].grid, span],
    [SPAN_VIEWS[span].list, span === 'week' ? 'list' : `list-${span}`],
  ]),
) as Record<ViewName, string>;

const WIDE_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  // 'capture' (camera) sits just left of the layout and span buttons.
  header: {
    left: 'today prev,next undo,redo',
    center: 'title',
    right: `ghosts capture layout-grid,layout-list ${WIDE_SPANS.map(spanButton).join(',')}`,
  },
  footer: false,
};
const NARROW_TOOLBAR: { header: ToolbarInput; footer: ToolbarInput | false } = {
  header: { left: 'today prev,next', center: 'title', right: '' },
  // Undo/redo at the bottom, within reach of the thumb; the spans in a menu (see openViewMenu).
  footer: { center: 'undo,redo ghosts capture layout viewMenu' },
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

/** What a dots-only calendar shows on one day: its dot (or icon) and the events behind it. */
interface DayDot {
  color: string;
  icon: string;
  name: string;
  events: AgendaEvent[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The view and date kept in the URL (?view=week&date=YYYY-MM-DD), so a reload stays there. */
function readUrlPosition(): { view?: ViewName; date?: string } {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('view');
  const date = params.get('date');
  return {
    view: VIEW_NAMES.find((v) => VIEW_URLS[v] === name),
    date: date && ISO_DATE.test(date) && !Number.isNaN(Date.parse(date)) ? date : undefined,
  };
}

/** Updates the URL in place (no new history entry for every period browsed). */
function writeUrlPosition(view: ViewName, date: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('view', VIEW_URLS[view]);
  url.searchParams.set('date', date);
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
}

/**
 * How events are built for a view: the year view turns them all into dots, and the week/day grids
 * draw ghosts in the background. Other changes of view reuse the events as they are.
 */
function fetchModeOf(view: string): string {
  return view === 'multiMonthYear' ? 'year' : view.startsWith('timeGrid') ? 'timeGrid' : 'plain';
}

/**
 * Whether events built for `fetched` (a fetchModeOf value) serve `view` as they are. Lists only
 * draw foreground events, so they also take the week/day grids' events (those add background
 * ghosts); the other way round, or from the year's dots, the events have to be rebuilt.
 */
function canReuseEvents(view: string, fetched: string): boolean {
  const mode = fetchModeOf(view);
  return mode === fetched || (view.startsWith('list') && fetched === 'timeGrid');
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

/**
 * Week/day views: event names keep to the lines that fit in the block and end with "…" instead
 * of being cut through a line (see .fc-timegrid-event .fc-event-title). Runs again when the block
 * is resized.
 */
const titleClamp = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const title = target.querySelector<HTMLElement>('.fc-event-title');
    if (!title) continue;
    const style = getComputedStyle(title);
    // "normal" line height: about 1.2 × the font size.
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const lines = Math.max(1, Math.floor(target.clientHeight / lineHeight));
    title.style.setProperty('-webkit-line-clamp', String(lines));
  }
});

/** Week/day views open an hour before the current time, rather than at midnight. */
function scrollTimeNow(timeZone: string): string {
  const hour = Number(instantToWall(Date.now(), timeZone).time.slice(0, 2));
  return `${String(Math.max(hour - 1, 0)).padStart(2, '0')}:00:00`;
}

/**
 * The day (and in week/day views, the time slot) under a point of the window: where a right
 * click on an empty part of the calendar would add an event. Null outside the grid.
 */
function slotAtPoint(x: number, y: number): { date: string; time?: string } | null {
  const stack = document.elementsFromPoint(x, y);
  const find = (selector: string) =>
    stack.find((el): el is HTMLElement => el instanceof HTMLElement && el.matches(selector));
  const column = find('.fc-timegrid-col[data-date]');
  const lane = find('.fc-timegrid-slot-lane[data-time]');
  if (column?.dataset.date && lane?.dataset.time) {
    return { date: column.dataset.date, time: lane.dataset.time.slice(0, 5) };
  }
  const day = find('.fc-daygrid-day[data-date]');
  return day?.dataset.date ? { date: day.dataset.date } : null;
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
  /** Days with an event of a dots-only calendar, from the last fetch: day → calendars' dots. */
  let dotDays = new Map<string, Map<string, DayDot>>();
  // The drop being handled is a copy (see eventDrop).
  let copyOnDrop = false;
  // While dragging an event, the cursor shows when dropping will copy it (Ctrl / Alt / ⌘ held).
  const showCopyCursor = (e: KeyboardEvent | MouseEvent) => {
    document.body.classList.toggle('is-copy-drag', e.ctrlKey || e.altKey || e.metaKey);
    // Releasing Alt would otherwise focus the browser's menu bar.
    if (e instanceof KeyboardEvent && e.key === 'Alt') e.preventDefault();
  };
  const watchCopyKeys = (on: boolean) => {
    for (const type of ['keydown', 'keyup', 'pointermove'] as const) {
      if (on) document.addEventListener(type, showCopyCursor, true);
      else document.removeEventListener(type, showCopyCursor, true);
    }
    if (!on) document.body.classList.remove('is-copy-drag');
  };

  // The view type as of the last datesSet (FullCalendar loads events before `calendar` exists).
  const fromUrl = readUrlPosition();
  let currentView: string = fromUrl.view ?? initial.defaultView;
  // What the loaded events were built for (see fetchModeOf): they are rebuilt when it changes.
  let fetchedMode = '';
  const calendar = new Calendar(host, {
    plugins: [
      dayGridPlugin,
      timeGridPlugin,
      listPlugin,
      multiMonthPlugin,
      interactionPlugin,
      intlTimeZonePlugin,
    ],
    initialView: currentView,
    // Reloading the page stays on the period that was shown (see writeUrlPosition).
    ...(fromUrl.date ? { initialDate: fromUrl.date } : {}),
    // English with day-before-month dates (e.g. titles: "20 – 26 Oct 2026").
    locale: 'en-GB',
    firstDay: initial.weekStartsOn,
    timeZone: initial.timeZone,
    headerToolbar: toolbar().header,
    footerToolbar: toolbar().footer,
    buttonText: {
      today: 'Today',
      month: 'Month',
      week: 'Week',
      day: 'Day',
      list: 'List',
      year: 'Year',
    },
    customButtons: {
      // Grid / list: the same time span shown the other way (see syncLayoutButtons).
      'layout-grid': {
        text: '',
        hint: 'Show the period as a grid',
        click: () => setLayout(false),
      },
      'layout-list': {
        text: '',
        hint: 'Show the period as a list',
        click: () => setLayout(true),
      },
      // Phones: one button showing the current layout, switching to the other.
      layout: { text: '', click: () => setLayout(!isListView(calendar.view.type)) },
      ...Object.fromEntries(
        SPAN_NAMES.map((span) => [
          spanButton(span),
          { text: SPAN_LABELS[span], click: () => setSpan(span) },
        ]),
      ),
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
            current: spanOf(calendar.view.type),
            views: SPAN_NAMES.map((span) => ({ view: span, label: SPAN_LABELS[span] })),
            onPick: (span) => setSpan(span as SpanName),
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
      // The list layout of the 3-day and 3-week spans (the other spans have a built-in list).
      listThreeDay: { type: 'list', duration: { days: 3 } },
      listThreeWeek: { type: 'list', duration: { weeks: 3 } },
      // The whole year, twelve small months: only dots (see the events source and syncDots).
      multiMonthYear: {
        multiMonthMaxColumns: 4,
        multiMonthMinWidth: 240,
        weekNumbers: false,
        // Only the weeks the month has, not always six rows.
        fixedWeekCount: false,
      },
    },
    // No label next to the all-day row.
    allDayText: '',
    dayHeaderContent,
    // Week numbers (ISO, "43"): on each row in month view, in the top-left corner in week/day
    // views. List view has none built in: see syncListWeekNumbers.
    weekNumbers: true,
    weekNumberCalculation: 'ISO',
    weekNumberContent: ({ num }) => ({ domNodes: [weekNumberBadge(num)] }),
    eventsSet: () => {
      requestAnimationFrame(syncListWeekNumbers);
      syncDots();
    },
    // 24-hour clock everywhere (time axis, event times, list view).
    slotLabelFormat: slotLabelFormat(),
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    height: '100%',
    nowIndicator: true,
    scrollTime: scrollTimeNow(initial.timeZone),
    // Going to another week/day keeps the hours scrolled to (only a new view starts at scrollTime).
    scrollTimeReset: false,
    dayMaxEvents: true,
    // Events at the same time side by side, each 1/N of the day width (not overlapping).
    slotEventOverlap: false,
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
    eventDragStart: (info) => {
      dragging = true;
      watchCopyKeys(true);
      showCopyCursor(info.jsEvent);
    },
    eventDragStop: () => {
      watchCopyKeys(false);
      setTimeout(() => (dragging = false));
    },
    eventResizeStart: () => (dragging = true),
    eventResizeStop: () => setTimeout(() => (dragging = false)),
    // Ctrl (or Alt / ⌘) held on drop: a copy goes to the new time, the event stays. eventDrop
    // runs just before eventChange, which does the copy.
    eventDrop: (info) => {
      const e = info.jsEvent;
      copyOnDrop = e.ctrlKey || e.altKey || e.metaKey;
    },
    eventChange: (info) => {
      const agendaEvent = agendaEventOf(info.event);
      const times = timesOf(info.event);
      const copy = copyOnDrop;
      copyOnDrop = false;
      if (!agendaEvent || !times) {
        info.revert();
        return;
      }
      if (copy) {
        info.revert();
        copyEventTo(agendaEvent, times);
        return;
      }
      void changeEventTimes(agendaEvent, times).then((ok) => {
        if (!ok) info.revert();
      });
    },
    events: (info, success) => {
      const all = eventsInRange(
        { start: info.start, end: info.end },
        (cal) => getCalendarSettings(cal.fileId, calendarIndex(cal.fileId)).visible,
      );
      // Calendars shown as dots only: no event, just their days (see syncDots).
      let events: AgendaEvent[] = [];
      const days = new Map<string, Map<string, DayDot>>();
      const { timeZone } = getSettings();
      // Year view: every calendar is shown as dots only.
      const yearView = currentView === 'multiMonthYear';
      fetchedMode = fetchModeOf(currentView);
      const dayOf = (instant: Date) => instantToWall(instant.getTime(), timeZone).date;
      const { showGhosts } = getSettings();
      const { calendars } = getCalendarState();
      // Per calendar, not per event: a year of a recurring event is hundreds of them.
      const styles = new Map<string, ReturnType<typeof getCalendarSettings>>();
      const names = new Map(calendars.map((c) => [c.fileId, c.displayName]));
      for (const event of all) {
        let style = styles.get(event.calendarFileId);
        if (!style) {
          style = getCalendarSettings(event.calendarFileId, calendarIndex(event.calendarFileId));
          styles.set(event.calendarFileId, style);
        }
        if (!style.dotsOnly && !yearView) {
          events.push(event);
          continue;
        }
        if (!showGhosts && isGhostEvent(event)) continue;
        const name = names.get(event.calendarFileId) ?? '';
        for (const day of eventDays(event, dayOf)) {
          const dots = days.get(day) ?? new Map();
          const dot = dots.get(event.calendarFileId) ?? {
            color: style.color,
            icon: style.icon,
            name,
            events: [],
          };
          dot.events.push(event);
          dots.set(event.calendarFileId, dot);
          days.set(day, dots);
        }
      }
      dotDays = days;
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
      // Not on the copy that follows the pointer while dragging, nor during a drag.
      if (agendaEvent && !info.isMirror) {
        attachEventTooltip(info.el, () => (dragging ? null : eventTooltipContent(agendaEvent)));
      }
      const titleContainer = info.el.querySelector('.fc-timegrid-event .fc-event-title-container');
      if (titleContainer) titleClamp.observe(titleContainer);
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
        // Middle click: ghosts the event, or brings it back. mousedown is cancelled so Windows
        // doesn't start its scroll-by-mouse mode.
        info.el.addEventListener('mousedown', (e) => {
          if (e.button === 1) e.preventDefault();
        });
        info.el.addEventListener('auxclick', (e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          setGhostEvent(agendaEvent, !isGhostEvent(agendaEvent));
        });
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
    eventWillUnmount: (info) => {
      detachEventTooltip(info.el);
      const titleContainer = info.el.querySelector('.fc-event-title-container');
      if (titleContainer) titleClamp.unobserve(titleContainer);
    },
    datesSet: (arg) => {
      requestAnimationFrame(syncListWeekNumbers);
      updateHistoryButtons();
      syncViewMenuButton();
      syncSpanButtons();
      syncTitleButton();
      const view = arg.view.type as ViewName;
      // Same dates in another view reuse the loaded events; reload so the list view can leave
      // out past events (and other views show them again).
      currentView = view;
      if (!canReuseEvents(view, fetchedMode)) queueMicrotask(() => calendar.refetchEvents());
      if (VIEW_NAMES.includes(view) && view !== getSettings().defaultView) {
        updateSettings({ defaultView: view });
      }
      // The first day shown, in the calendar's time zone.
      writeUrlPosition(view, calendar.formatIso(arg.view.currentStart, true).slice(0, 10));
    },
  });
  calendar.render();

  /** One dot per dots-only calendar with an event, in each day cell (month) or column header. */
  function syncDots(): void {
    host
      .querySelectorAll('.day-dot, .day-icon')
      .forEach((el) => detachEventTooltip(el as HTMLElement));
    host.querySelectorAll('.day-dots').forEach((el) => el.remove());
    const type = calendar.view.type;
    if (type.startsWith('list')) return;
    const month = type.startsWith('dayGrid') || type.startsWith('multiMonth');
    const targets = month
      ? host.querySelectorAll<HTMLElement>('.fc-daygrid-day[data-date]')
      : host.querySelectorAll<HTMLElement>('.fc-col-header-cell[data-date]');
    for (const target of targets) {
      const dots = dotDays.get(target.dataset.date ?? '');
      if (!dots) continue;
      const row = document.createElement('span');
      row.className = 'day-dots';
      for (const { color, icon, name, events } of dots.values()) {
        const dot = document.createElement('span');
        dot.setAttribute('role', 'img');
        dot.setAttribute(
          'aria-label',
          `${name}: ${events.length} event${events.length > 1 ? 's' : ''}`,
        );
        // One event: the usual event card; several: their names.
        const [only] = events;
        attachEventTooltip(dot, () =>
          events.length === 1 && only ? eventTooltipContent(only) : eventListTooltipContent(events),
        );
        if (icon) {
          // The calendar's icon, in its color, instead of a dot.
          dot.className = 'day-icon';
          dot.textContent = icon;
          dot.style.color = color;
          // Dark icons get an outline (see .day-icon.is-dark); light ones are visible already.
          dot.classList.toggle('is-dark', isHardOnDark(color));
        } else {
          dot.className = 'day-dot';
          dot.style.background = color;
        }
        row.appendChild(dot);
      }
      if (month) target.querySelector('.fc-daygrid-day-top')?.appendChild(row);
      else target.querySelector('.day-header-label')?.appendChild(row);
    }
  }

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

  /** The toolbar title (the dates shown) opens the month picker: a button for keyboards too. */
  function syncTitleButton(): void {
    for (const title of host.querySelectorAll<HTMLElement>('.fc-toolbar-title')) {
      title.setAttribute('role', 'button');
      title.tabIndex = 0;
      title.title = 'Go to a month or year';
      title.setAttribute('aria-haspopup', 'dialog');
    }
  }

  function showMonthPicker(title: HTMLElement): void {
    openMonthPicker(title, {
      current: calendar.formatIso(calendar.getDate(), true).slice(0, 7),
      today: instantToWall(Date.now(), getSettings().timeZone).date.slice(0, 7),
      onPick: (month) => calendar.gotoDate(`${month}-01`),
      onToday: () => calendar.today(),
    });
  }

  /**
   * Goes to a view. `currentView` is set first so that the events FullCalendar loads for it are
   * the right ones at once (not built for the old view, then rebuilt: a full year is slow).
   */
  function showView(view: ViewName): void {
    currentView = view;
    calendar.changeView(view);
  }

  /** Another time span, in the current layout. */
  function setSpan(span: SpanName): void {
    showView(viewFor(span, isListView(calendar.view.type)));
  }

  /** The current time span as a list or as a grid. */
  function setLayout(list: boolean): void {
    showView(viewFor(spanOf(calendar.view.type), list));
  }

  /** The phone view menu button shows the current span's name (and ▾). */
  function syncViewMenuButton(): void {
    const btn = host.querySelector<HTMLButtonElement>('.fc-viewMenu-button');
    if (!btn) return;
    btn.textContent = `${SPAN_LABELS[spanOf(calendar.view.type)]} ▾`;
    btn.setAttribute('aria-haspopup', 'menu');
  }

  /** Highlights the current span and layout; the phone layout button names the other layout. */
  function syncSpanButtons(): void {
    const type = calendar.view.type;
    const list = isListView(type);
    const span = spanOf(type);
    const mark = (selector: string, active: boolean) => {
      for (const btn of host.querySelectorAll<HTMLButtonElement>(selector)) {
        btn.classList.toggle('fc-button-active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    };
    for (const name of SPAN_NAMES) mark(`.fc-${spanButton(name)}-button`, name === span);
    mark('.fc-layout-grid-button', !list);
    mark('.fc-layout-list-button', list);
    for (const btn of host.querySelectorAll<HTMLButtonElement>('.fc-layout-grid-button')) {
      btn.setAttribute('aria-label', 'Grid');
    }
    for (const btn of host.querySelectorAll<HTMLButtonElement>('.fc-layout-list-button')) {
      btn.setAttribute('aria-label', 'List');
    }
    for (const btn of host.querySelectorAll<HTMLButtonElement>('.fc-layout-button')) {
      // The icon (see CSS) and the label are those of the layout the button switches to.
      btn.dataset.target = list ? 'grid' : 'list';
      btn.title = list ? 'Show the period as a grid' : 'Show the period as a list';
      btn.setAttribute('aria-label', btn.title);
    }
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

  const offSwipes = listenForSwipes(
    host,
    // Not while dragging an event, nor with the "+N more" popover open.
    () => dragging || host.querySelector('.fc-popover') !== null,
    (direction) => (direction === 'next' ? calendar.next() : calendar.prev()),
  );

  // The toolbar title is rebuilt with the toolbar: listen on the host.
  const onTitleClick = (e: MouseEvent) => {
    const title = (e.target as Element).closest<HTMLElement>('.fc-toolbar-title');
    if (title) showMonthPicker(title);
  };
  const onTitleKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const title = (e.target as Element).closest<HTMLElement>('.fc-toolbar-title');
    if (!title) return;
    e.preventDefault();
    showMonthPicker(title);
  };
  host.addEventListener('click', onTitleClick);
  host.addEventListener('keydown', onTitleKey);

  // Right click on an empty slot or day: "New event here". Events open their own menu first (and
  // prevent the default); on touch screens a long press selects a range instead.
  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented || (e as PointerEvent).pointerType === 'touch') return;
    const slot = slotAtPoint(e.clientX, e.clientY);
    if (!slot) return;
    e.preventDefault();
    openSlotMenu(slot, e.clientX, e.clientY);
  };
  host.addEventListener('contextmenu', onContextMenu);

  const onResize = () => {
    calendar.setOption('headerToolbar', toolbar().header);
    calendar.setOption('footerToolbar', toolbar().footer);
    calendar.setOption('slotLabelFormat', slotLabelFormat());
    // The toolbars were rebuilt.
    updateHistoryButtons();
    syncGhostsButton();
    syncViewMenuButton();
    syncSpanButtons();
    syncTitleButton();
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
    changeSpan: setSpan,
    toggleLayout: () => setLayout(!isListView(calendar.view.type)),
    showEvent: (event) => calendar.gotoDate(event.startInput),
    updateSize: () => calendar.updateSize(),
    destroy() {
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('click', onTitleClick);
      host.removeEventListener('keydown', onTitleKey);
      offSwipes();
      watchCopyKeys(false);
      offHistory();
      narrow.removeEventListener('change', onResize);
      offSettings();
      offCalendars();
      calendar.destroy();
    },
  };
}
