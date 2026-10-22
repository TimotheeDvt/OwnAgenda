import {
  calendarIndex,
  getCalendarState,
  onCalendarsChange,
  searchEvents,
} from '../store/calendarStore';
import { getCalendarSettings, getSettings } from '../store/settingsStore';
import type { AgendaEvent } from '../types';

const DEBOUNCE_MS = 150;

function formatWhen(event: AgendaEvent): string {
  const { timeZone } = getSettings();
  if (event.allDay) {
    return new Date(`${event.startInput}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return event.start.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    // Floating times are wall-clock times: their Date is in the browser zone.
    timeZone: event.startInput.endsWith('Z') ? timeZone : undefined,
  });
}

export interface SearchBox {
  focus(): void;
  destroy(): void;
}

/** Search field with a result list. Picking a result calls `onPick`. */
export function mountSearch(host: HTMLElement, onPick: (event: AgendaEvent) => void): SearchBox {
  host.innerHTML = `
    <input class="search-input" type="search" placeholder="Search events  ( / )"
      aria-label="Search events" autocomplete="off" />
    <p class="search-summary muted" hidden></p>
    <ul class="search-results"></ul>`;
  const input = host.querySelector<HTMLInputElement>('.search-input')!;
  const summary = host.querySelector<HTMLElement>('.search-summary')!;
  const list = host.querySelector<HTMLUListElement>('.search-results')!;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const render = () => {
    const query = input.value.trim();
    if (!query) {
      summary.hidden = true;
      list.replaceChildren();
      return;
    }
    const results = searchEvents(query);
    const calendars = new Map(getCalendarState().calendars.map((c) => [c.fileId, c]));
    summary.hidden = false;
    summary.textContent =
      results.length === 0
        ? 'No events found.'
        : `${results.length}${results.length >= 100 ? '+' : ''} result${results.length === 1 ? '' : 's'}`;

    list.replaceChildren(
      ...results.map((event) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'search-result';
        const dot = document.createElement('span');
        dot.className = 'search-dot';
        dot.style.background = getCalendarSettings(
          event.calendarFileId,
          calendarIndex(event.calendarFileId),
        ).color;
        const text = document.createElement('span');
        text.className = 'search-text';
        const title = document.createElement('span');
        title.className = 'search-title';
        title.textContent = `${event.title || '(No title)'}${event.recurring ? ' ↻' : ''}`;
        const meta = document.createElement('span');
        meta.className = 'search-meta';
        meta.textContent = [formatWhen(event), calendars.get(event.calendarFileId)?.displayName]
          .filter(Boolean)
          .join(' · ');
        text.append(title, meta);
        button.append(dot, text);
        button.addEventListener('click', () => onPick(event));
        item.appendChild(button);
        return item;
      }),
    );
  };

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(render, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      render();
    } else if (e.key === 'Enter') {
      list.querySelector<HTMLButtonElement>('.search-result')?.click();
    }
  });
  // Results follow edits, reloads and refreshes.
  let lastCalendars = getCalendarState().calendars;
  const off = onCalendarsChange((state) => {
    if (state.calendars === lastCalendars) return;
    lastCalendars = state.calendars;
    if (input.value.trim()) render();
  });

  return {
    focus: () => {
      input.focus();
      input.select();
    },
    destroy: () => {
      if (timer) clearTimeout(timer);
      off();
      host.replaceChildren();
    },
  };
}
