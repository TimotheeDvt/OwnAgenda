import {
  calendarIndex,
  eventsInRange,
  getCalendarState,
  onCalendarsChange,
} from '../store/calendarStore';
import { getCalendarSettings, getSettings, onSettingsChange } from '../store/settingsStore';
import type { AgendaEvent } from '../types';

/** Timed events of visible calendars happening right now, the one ending first first. */
function currentEvents(now: Date): AgendaEvent[] {
  if (getCalendarState().status !== 'ready') return [];
  return eventsInRange(
    { start: now, end: new Date(now.getTime() + 1) },
    (cal) => getCalendarSettings(cal.fileId, calendarIndex(cal.fileId)).visible,
  )
    .filter((e) => !e.allDay && e.start <= now && now < e.end)
    .sort((a, b) => a.end.getTime() - b.end.getTime());
}

function formatEnd(event: AgendaEvent): string {
  return event.end.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    // Floating times are wall-clock times: their Date is in the browser zone.
    timeZone: event.endInput.endsWith('Z') ? getSettings().timeZone : undefined,
  });
}

/**
 * "Now" bubble in the header: the event happening right now (title, until when), "+N" when
 * several overlap; empty when nothing is going on. Clicking it opens the event.
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

  const render = () => {
    const events = currentEvents(new Date());
    shown = events[0] ?? null;
    if (!shown) {
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
    until.textContent = `until ${formatEnd(shown)}`;
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
    bubble.title = `Now: ${shown.title || '(No title)'} (until ${formatEnd(shown)})`;
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
    host.replaceChildren();
  };
}
