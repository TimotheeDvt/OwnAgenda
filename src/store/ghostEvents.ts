import type { AgendaEvent } from '../types';
import { getSettings, updateSettings, type GhostEvent } from './settingsStore';

/**
 * Ghost events: occurrences shown faded in the calendar (a display setting, kept in the
 * settings). Entries are dropped once the event is over or when it is deleted from the app.
 */

type Occurrence = Pick<AgendaEvent, 'id' | 'start' | 'end'>;

export function isGhostEvent(event: Pick<AgendaEvent, 'id'>): boolean {
  return getSettings().ghostEvents.some((g) => g.id === event.id);
}

function save(next: GhostEvent[]): void {
  const current = getSettings().ghostEvents;
  if (next.length !== current.length || next.some((g, i) => g !== current[i])) {
    updateSettings({ ghostEvents: next });
  }
}

/** Fades the occurrence in the calendar, or brings it back. */
export function setGhostEvent(event: Occurrence, ghost: boolean): void {
  const others = getSettings().ghostEvents.filter((g) => g.id !== event.id);
  if (!ghost) return save(others);
  save([
    ...others,
    { id: event.id, start: event.start.toISOString(), end: event.end.toISOString() },
  ]);
}

/** Drops ghosts of events that are over. */
export function pruneGhostEvents(now = Date.now()): void {
  save(getSettings().ghostEvents.filter((g) => Date.parse(g.end) > now));
}

/**
 * After deleting `event`: drops its ghost, or with `series`, those of every occurrence of its
 * series (from `event`'s start on, for "this and following").
 */
export function forgetGhostEvents(event: AgendaEvent, series?: 'all' | 'following'): void {
  if (!series) return save(getSettings().ghostEvents.filter((g) => g.id !== event.id));
  const seriesId = `${event.calendarFileId}/${event.uid}`;
  const from = event.start.getTime();
  save(
    getSettings().ghostEvents.filter((g) => {
      const inSeries = g.id === seriesId || g.id.startsWith(`${seriesId}/`);
      return !inSeries || (series === 'following' && Date.parse(g.start) < from);
    }),
  );
}

/** After editing `event`: its ghost follows it (new times, or another calendar). */
export function moveGhostEvent(
  event: AgendaEvent,
  times: { start: number; end: number },
  targetFileId: string,
): void {
  if (!isGhostEvent(event)) return;
  const id = `${targetFileId}${event.id.slice(event.calendarFileId.length)}`;
  const others = getSettings().ghostEvents.filter((g) => g.id !== event.id && g.id !== id);
  save([
    ...others,
    { id, start: new Date(times.start).toISOString(), end: new Date(times.end).toISOString() },
  ]);
}
