import {
  calendarIndex,
  eventsInRange,
  getCalendarState,
  onCalendarsChange,
} from '../store/calendarStore';
import { getCalendarSettings, getSettings, onSettingsChange } from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { formatStartsIn } from '../util/dates';
import { browserTimeZone } from '../util/timeZone';
import { attachEventTooltip, detachEventTooltip, eventTooltipContent } from './eventTooltip';

/** How far ahead to look for the next event when nothing is going on. */
const LOOKAHEAD_MS = 7 * 24 * 3600_000;

interface NowState {
  /** Timed events happening right now, the one ending first first. */
  current: AgendaEvent[];
  /** Timed events starting soonest (several when they start at the same time), when nothing is current. */
  next: AgendaEvent[];
}

/** Current (or else upcoming) timed events of visible calendars. */
function nowState(now: Date): NowState {
  if (getCalendarState().status !== 'ready') return { current: [], next: [] };
  const events = eventsInRange(
    { start: now, end: new Date(now.getTime() + LOOKAHEAD_MS) },
    (cal) => {
      const { visible, dotsOnly } = getCalendarSettings(cal.fileId, calendarIndex(cal.fileId));
      return visible && !dotsOnly;
    },
  ).filter((e) => !e.allDay && now < e.end);
  const current = events
    .filter((e) => e.start <= now)
    .sort((a, b) => a.end.getTime() - b.end.getTime());
  if (current.length > 0) return { current, next: [] };
  const upcoming = events.sort((a, b) => a.start.getTime() - b.start.getTime());
  const first = upcoming[0];
  const next = first ? upcoming.filter((e) => e.start.getTime() === first.start.getTime()) : [];
  return { current: [], next };
}

/** Zone an event's times are shown in: floating times are wall-clock times in the browser zone. */
function displayZone(input: string): string {
  return input.endsWith('Z') ? getSettings().timeZone : browserTimeZone();
}

function formatEnd(event: AgendaEvent): string {
  return event.end.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: displayZone(event.endInput),
  });
}

/**
 * "Now" bubble in the header: the event happening right now (title, until when), "+N" when
 * several overlap; when nothing is going on, the next event (title, "in …"); empty when there is
 * none within a week. Clicking it opens the event.
 */
export function mountCurrentEvent(
  host: HTMLElement,
  onOpen: (event: AgendaEvent) => void,
): () => void {
  let shown: AgendaEvent | null = null;
  const bubble = document.createElement('button');
  bubble.type = 'button';
  bubble.className = 'current-event';
  bubble.addEventListener('click', () => {
    if (shown) onOpen(shown);
  });
  // Same hover card as the event in the calendar.
  attachEventTooltip(bubble, () => (shown ? eventTooltipContent(shown) : null));

  const render = () => {
    const now = new Date();
    const state = nowState(now);
    const upcoming = state.current.length === 0;
    const events = upcoming ? state.next : state.current;
    shown = events[0] ?? null;
    bubble.classList.toggle('upcoming', upcoming);
    if (!shown) {
      detachEventTooltip(bubble);
      host.replaceChildren();
      return;
    }
    const settings = getCalendarSettings(shown.calendarFileId, calendarIndex(shown.calendarFileId));
    const dot = document.createElement('span');
    dot.className = 'current-event-dot';
    dot.style.background = settings.color;
    const title = document.createElement('span');
    title.className = 'current-event-title';
    title.textContent = `${settings.icon ? `${settings.icon} ` : ''}${shown.title || '(No title)'}`;
    const until = document.createElement('span');
    until.className = 'current-event-until';
    until.textContent = upcoming
      ? formatStartsIn(shown.start.getTime(), now.getTime(), displayZone(shown.startInput))
      : `until ${formatEnd(shown)}`;
    const nodes: Node[] = [dot, title, until];
    if (events.length > 1) {
      const more = document.createElement('span');
      more.className = 'current-event-more';
      more.textContent = `+${events.length - 1}`;
      more.title = events
        .slice(1)
        .map((e) => e.title || '(No title)')
        .join('\n');
      nodes.push(more);
    }
    bubble.replaceChildren(...nodes);
    if (bubble.parentElement !== host) host.replaceChildren(bubble);
  };

  // Re-check at every minute boundary, when calendars change and when settings change
  // (calendar shown/hidden, color, time zone).
  let interval: ReturnType<typeof setInterval> | undefined;
  const align = setTimeout(
    () => {
      render();
      interval = setInterval(render, 60_000);
    },
    60_000 - (Date.now() % 60_000),
  );
  const offCalendars = onCalendarsChange(render);
  const offSettings = onSettingsChange(render);
  render();

  return () => {
    clearTimeout(align);
    clearInterval(interval);
    offCalendars();
    offSettings();
    detachEventTooltip(bubble);
    host.replaceChildren();
  };
}
