import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetGhostEvents,
  isGhostEvent,
  moveGhostEvent,
  pruneGhostEvents,
  setGhostEvent,
} from '../src/store/ghostEvents';
import { getSettings, resetSettings } from '../src/store/settingsStore';
import type { AgendaEvent } from '../src/types';

const event = (id: string, start: string, end: string, recurring = false): AgendaEvent => {
  const [calendarFileId = '', uid = ''] = id.split('/');
  return {
    id,
    uid,
    calendarFileId,
    title: '',
    start: new Date(start),
    end: new Date(end),
    allDay: false,
    recurring,
    startInput: start,
    endInput: end,
  };
};

const ids = () => getSettings().ghostEvents.map((g) => g.id);

describe('ghost events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSettings();
  });
  afterEach(() => {
    resetSettings();
    vi.useRealTimers();
  });

  it('toggles an occurrence', () => {
    const e = event('f/a', '2026-10-22T08:00:00Z', '2026-10-22T09:00:00Z');
    setGhostEvent(e, true);
    expect(isGhostEvent(e)).toBe(true);
    setGhostEvent(e, false);
    expect(isGhostEvent(e)).toBe(false);
  });

  it('drops ghosts of events that are over', () => {
    setGhostEvent(event('f/past', '2026-10-20T08:00:00Z', '2026-10-20T09:00:00Z'), true);
    setGhostEvent(event('f/now', '2026-10-22T08:00:00Z', '2026-10-22T12:00:00Z'), true);
    setGhostEvent(event('f/later', '2026-10-25T08:00:00Z', '2026-10-25T09:00:00Z'), true);
    pruneGhostEvents(Date.parse('2026-10-22T10:00:00Z'));
    expect(ids()).toEqual(['f/now', 'f/later']);
  });

  it('forgets deleted events, a whole series, or this and following', () => {
    const occ = (day: number) =>
      event(
        `f/s/2026-10-${day}T08:00:00`,
        `2026-10-${day}T08:00:00Z`,
        `2026-10-${day}T09:00:00Z`,
        true,
      );
    const single = event('f/x', '2026-10-22T08:00:00Z', '2026-10-22T09:00:00Z');
    for (const e of [
      single,
      occ(20),
      occ(22),
      occ(24),
      event('f/s2', '2026-10-22T08:00:00Z', '2026-10-22T09:00:00Z'),
    ]) {
      setGhostEvent(e, true);
    }
    forgetGhostEvents(single);
    expect(ids()).not.toContain('f/x');
    forgetGhostEvents(occ(22), 'following');
    expect(ids()).toEqual(['f/s/2026-10-20T08:00:00', 'f/s2']);
    forgetGhostEvents(occ(20), 'all');
    expect(ids()).toEqual(['f/s2']);
  });

  it('follows an edited event to its new time and calendar', () => {
    const e = event('f/a', '2026-10-22T08:00:00Z', '2026-10-22T09:00:00Z');
    setGhostEvent(e, true);
    const end = Date.parse('2026-10-30T10:00:00Z');
    moveGhostEvent(e, { start: end - 3_600_000, end }, 'g');
    expect(getSettings().ghostEvents).toEqual([
      { id: 'g/a', start: '2026-10-30T09:00:00.000Z', end: '2026-10-30T10:00:00.000Z' },
    ]);
  });
});
