import { storage, type FileMeta } from '../storage';
import {
  createEvent,
  moveComponents,
  moveEvent,
  newCalendarComponent,
  removeEvent,
  renameCalendarComponent,
  updateEvent,
  type EventDraft,
} from '../ics/edit';
import { toCalendarFile } from '../ics/parse';
import { expandCalendar } from '../ics/recurrence';
import {
  deleteFollowing,
  deleteOccurrence,
  editFollowing,
  editOccurrence,
  editSeries,
  seriesRule,
  type EditScope,
  type OccurrenceRef,
} from '../ics/recurringEdit';
import type { SimpleRule } from '../ics/rrule';
import { serializeCalendar } from '../ics/serialize';
import {
  buildSubscriptionCalendar,
  isStale,
  normalizeSubscriptionUrl,
  subscriptionInfo,
  type SubscriptionInfo,
} from '../ics/subscription';
import { fetchRemoteCalendar } from '../net/remoteCalendar';
import type { AgendaEvent, CalendarFile, DateRange } from '../types';
import { eventInputToIso } from '../util/dates';
import type { CachedFile } from './offlineCache';
import { getSettings } from './settingsStore';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * - saving: an upload is in progress
 * - unsaved: changes are waiting (e.g. for a conflict decision)
 * - error: the last save failed; changes are kept and can be retried
 * - saved: everything changed in this session is on Drive
 */
export type SaveStatus = 'idle' | 'saving' | 'unsaved' | 'error' | 'saved';

export interface CalendarState {
  status: LoadStatus;
  /** Fatal error for the whole load (folder missing, Drive unreachable…). */
  error: string | null;
  /** Per-file problems that didn't stop the other calendars from loading. */
  warnings: string[];
  calendars: CalendarFile[];
  /** Drive ID of the loaded folder (needed to create calendars). */
  folderId: string | null;
  /** True while the calendars come from the offline copy rather than from Drive. */
  fromCache: boolean;
  /** Calendars currently being refreshed from Drive. */
  refreshing: string[];
  saveStatus: SaveStatus;
  saveError: string | null;
  /**
   * Why nothing can be changed right now, or null when editing is possible:
   * - offline: no network (or storage unreachable); showing the offline copy
   * - expired: the sign-in session expired; waiting for the user to reconnect
   */
  readOnly: ReadOnlyReason | null;
}

export type ReadOnlyReason = 'offline' | 'expired';

export type CalendarListener = (state: CalendarState) => void;
/** "later" keeps the changes unsaved; saving again asks again. */
export type ConflictChoice = 'reload' | 'overwrite' | 'later';

const initialState = (): CalendarState => ({
  status: 'idle',
  error: null,
  warnings: [],
  calendars: [],
  folderId: null,
  fromCache: false,
  refreshing: [],
  saveStatus: 'idle',
  saveError: null,
  readOnly: null,
});

let state: CalendarState = initialState();
let loadGeneration = 0;
const listeners = new Set<CalendarListener>();

/** Per file: incremented on every edit, so a save can tell if more edits came in meanwhile. */
const editVersions = new Map<string, number>();
const runningSaves = new Map<string, Promise<void>>();
const pendingResaves = new Set<string>();
const saveErrors = new Map<string, string>();
let savedOnce = false;

let conflictHandler: (calendar: CalendarFile) => Promise<ConflictChoice> = async () => 'reload';
let saveErrorHandler: (calendar: CalendarFile, message: string) => void = () => {};
let subscriptionErrorHandler: (calendar: CalendarFile, message: string) => void = () => {};

function setState(patch: Partial<CalendarState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function getCalendarState(): CalendarState {
  return state;
}

function findCalendar(fileId: string): CalendarFile | undefined {
  return state.calendars.find((c) => c.fileId === fileId);
}

export function calendarIndex(fileId: string): number {
  return state.calendars.findIndex((c) => c.fileId === fileId);
}

function resetSaveTracking(): void {
  editVersions.clear();
  pendingResaves.clear();
  saveErrors.clear();
  savedOnce = false;
}

const byName = (a: CalendarFile, b: CalendarFile) => a.name.localeCompare(b.name);

// ---------------------------------------------------------------------------------------------
// Loading

/** Shows calendars from the offline copy until Drive answers. Ignored once data is loaded. */
export function loadFromCache(files: CachedFile[]): void {
  if (state.calendars.length > 0 || state.status === 'ready') return;
  const calendars: CalendarFile[] = [];
  for (const file of files) {
    try {
      calendars.push(toCalendarFile(file.meta, file.content));
    } catch {
      // A broken cached file is simply skipped; Drive will provide a fresh copy.
    }
  }
  setState({ calendars: calendars.sort(byName), fromCache: true });
}

/**
 * Resolves the folder, then downloads and parses every .ics file in parallel, always from Drive.
 * A file that fails becomes a warning; the others still load. Unsaved changes are discarded.
 * If Drive can't be reached and the offline copy is shown, it stays visible.
 */
export async function loadCalendars(folderPath: string): Promise<void> {
  const generation = ++loadGeneration;
  resetSaveTracking();
  setState({ status: 'loading', error: null, warnings: [], saveStatus: 'idle', saveError: null });

  try {
    const { folderId, files } = await storage().listFiles(folderPath);
    const results = await Promise.allSettled(
      files.map(async (meta) => toCalendarFile(meta, await storage().download(meta.id))),
    );
    if (generation !== loadGeneration) return;

    const calendars: CalendarFile[] = [];
    const warnings: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') calendars.push(result.value);
      else warnings.push(`${files[i]?.name ?? 'File'}: ${errorMessage(result.reason)}`);
    });
    if (files.length === 0) warnings.push(`No .ics files found in "${folderPath}".`);
    setState({
      status: 'ready',
      calendars,
      warnings,
      folderId,
      fromCache: false,
      refreshing: [],
      // Storage answered, so we are online again.
      readOnly: state.readOnly === 'offline' ? null : state.readOnly,
    });
    // Subscriptions whose copy is more than a day old are re-downloaded in the background.
    void syncStaleSubscriptions();
  } catch (err) {
    if (generation !== loadGeneration) return;
    if (state.fromCache && state.calendars.length > 0) {
      setState({
        status: 'ready',
        readOnly: state.readOnly ?? 'offline',
        warnings: [
          `Could not reach Google Drive (${errorMessage(err)}). Showing the copy saved on this device.`,
        ],
      });
    } else {
      setState({ status: 'error', error: errorMessage(err), calendars: [], fromCache: false });
    }
  }
}

/** Re-downloads one calendar from Drive, discarding its local changes. */
export async function reloadCalendar(fileId: string): Promise<void> {
  const current = findCalendar(fileId);
  if (!current) return;
  const generation = loadGeneration;
  const meta = await storage().getMeta(fileId);
  const fresh = toCalendarFile(meta, await storage().download(fileId));
  if (generation !== loadGeneration) return;
  editVersions.delete(fileId);
  saveErrors.delete(fileId);
  pendingResaves.delete(fileId);
  setState({ calendars: state.calendars.map((c) => (c.fileId === fileId ? fresh : c)) });
  updateSaveStatus();
}

/**
 * Refresh button: re-downloads one calendar. Returns whether Drive had a newer version than the
 * one shown.
 */
export async function refreshCalendar(fileId: string): Promise<'updated' | 'unchanged'> {
  assertWritable();
  const before = findCalendar(fileId);
  if (!before) throw new Error('That calendar is no longer loaded.');
  setState({ refreshing: [...state.refreshing, fileId] });
  try {
    await reloadCalendar(fileId);
    const after = findCalendar(fileId);
    return after && after.modifiedTime !== before.modifiedTime ? 'updated' : 'unchanged';
  } finally {
    setState({ refreshing: state.refreshing.filter((id) => id !== fileId) });
  }
}

export function clearCalendars(): void {
  loadGeneration++;
  resetSaveTracking();
  setState(initialState());
}

/** Occurrences of all calendars accepted by `include` that overlap the range. */
export function eventsInRange(
  range: DateRange,
  include: (calendar: CalendarFile) => boolean,
): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const calendar of state.calendars) {
    if (!include(calendar)) continue;
    try {
      events.push(...expandCalendar(calendar.vcalendar, calendar.fileId, range));
    } catch (err) {
      console.warn(`Could not expand events of ${calendar.name}`, err);
    }
  }
  return events;
}

/** Contents for the offline copy, or null while there are unsaved changes or cached data. */
export function snapshotFiles(): CachedFile[] | null {
  if (state.status !== 'ready' || state.fromCache) return null;
  if (state.calendars.some((c) => c.dirty) || runningSaves.size > 0) return null;
  return state.calendars.map((c) => ({
    meta: { id: c.fileId, name: c.name, modifiedTime: c.modifiedTime },
    content: serializeCalendar(c.vcalendar),
  }));
}

// ---------------------------------------------------------------------------------------------
// Search

const SEARCH_PAST_MS = 365 * 86_400_000;
const SEARCH_FUTURE_MS = 2 * 365 * 86_400_000;
const SEARCH_LIMIT = 100;

/**
 * Events whose title, location or description contains every word of the query, from a year ago
 * to two years ahead. A recurring series appears once: its next occurrence (or its last one).
 */
export function searchEvents(query: string, now = new Date()): AgendaEvent[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const range = {
    start: new Date(now.getTime() - SEARCH_PAST_MS),
    end: new Date(now.getTime() + SEARCH_FUTURE_MS),
  };
  const matches = eventsInRange(range, () => true).filter((e) => {
    const text = [e.title, e.location, e.description].join('\n').toLowerCase();
    return words.every((w) => text.includes(w));
  });

  const series = new Map<string, AgendaEvent>();
  const single: AgendaEvent[] = [];
  for (const event of matches) {
    if (!event.recurring) {
      single.push(event);
      continue;
    }
    const key = `${event.calendarFileId}/${event.uid}`;
    const best = series.get(key);
    const isUpcoming = event.end >= now;
    if (
      !best ||
      (isUpcoming && (best.end < now || event.start < best.start)) ||
      (!isUpcoming && best.end < now && event.start > best.start)
    ) {
      series.set(key, event);
    }
  }
  return [...single, ...series.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, SEARCH_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Editing

function requireCalendar(fileId: string): CalendarFile {
  const calendar = findCalendar(fileId);
  if (!calendar) throw new Error('That calendar is no longer loaded.');
  return calendar;
}

/** Subscribed calendars are copies of an online calendar: their events can't be edited. */
export function readOnlyMessage(reason: ReadOnlyReason): string {
  return reason === 'offline'
    ? "You're offline: the calendars are read-only until the connection is back."
    : 'Your Google session expired: reconnect to make changes.';
}

/** Throws while changes are impossible (offline, or the session expired). */
function assertWritable(): void {
  if (state.readOnly) throw new Error(readOnlyMessage(state.readOnly));
}

/** Enters or leaves read-only mode. Leaving it saves the changes that were waiting. */
export function setReadOnly(reason: ReadOnlyReason | null): void {
  if (state.readOnly === reason) return;
  setState({ readOnly: reason });
  if (!reason) retrySaves();
  else updateSaveStatus();
}

function requireEditable(fileId: string): CalendarFile {
  assertWritable();
  const calendar = requireCalendar(fileId);
  if (subscriptionInfo(calendar.vcalendar)) {
    throw new Error(`"${calendar.displayName}" is a subscribed calendar and can't be edited.`);
  }
  return calendar;
}

/** Applies an edit to one or more calendars, refreshes the view, then saves them. */
function mutate(calendars: CalendarFile[], apply: () => void): void {
  apply();
  for (const calendar of calendars) {
    calendar.dirty = true;
    editVersions.set(calendar.fileId, (editVersions.get(calendar.fileId) ?? 0) + 1);
  }
  setState({ calendars: [...state.calendars] });
  for (const calendar of calendars) void requestSave(calendar.fileId);
}

/** An event's current times and fields, in EventDraft format (as edited in the dialog). */
export function eventToDraft(event: AgendaEvent): EventDraft {
  const { timeZone } = getSettings();
  return {
    title: event.title,
    allDay: event.allDay,
    start: event.allDay ? event.startInput : eventInputToIso(event.startInput, timeZone),
    end: event.allDay ? event.endInput : eventInputToIso(event.endInput, timeZone),
    location: event.location,
    description: event.description,
  };
}

function occurrenceRef(event: AgendaEvent): OccurrenceRef {
  const { allDay, start, end } = eventToDraft(event);
  return { uid: event.uid, recurrenceId: event.recurrenceId!, original: { allDay, start, end } };
}

/** The repeat rule of the event's series (for the editor). */
export function ruleOfEvent(event: AgendaEvent): { rule: SimpleRule | null; custom: boolean } {
  const calendar = findCalendar(event.calendarFileId);
  if (!calendar) return { rule: null, custom: false };
  return seriesRule(calendar.vcalendar, event.uid, getSettings().timeZone);
}

export function addEvent(fileId: string, draft: EventDraft): void {
  const calendar = requireEditable(fileId);
  mutate([calendar], () => {
    createEvent(calendar.vcalendar, draft, getSettings().timeZone);
  });
}

export interface EditOptions {
  /** For occurrences of a series: which occurrences the edit applies to (default: all). */
  scope?: EditScope;
  /** Moves the event (the whole series for recurring events) to another calendar. */
  targetFileId?: string;
}

export function editEvent(event: AgendaEvent, draft: EventDraft, options: EditOptions = {}): void {
  const source = requireEditable(event.calendarFileId);
  const target = requireEditable(options.targetFileId ?? source.fileId);
  const timeZone = getSettings().timeZone;
  const moving = target !== source;

  // A plain, non-recurring event.
  if (!event.recurrenceId) {
    if (!moving) mutate([source], () => updateEvent(source.vcalendar, event.uid, draft, timeZone));
    else {
      mutate([source, target], () =>
        moveEvent(source.vcalendar, target.vcalendar, event.uid, draft, timeZone),
      );
    }
    return;
  }

  const ref = occurrenceRef(event);
  // An override whose series isn't in the file: edit it on its own.
  if (!event.recurring) {
    if (moving) throw new Error('This event can only be edited in its own calendar.');
    mutate([source], () =>
      editOccurrence(source.vcalendar, ref, { ...draft, rrule: undefined }, timeZone),
    );
    return;
  }

  const scope = options.scope ?? 'all';
  if (moving) {
    if (scope !== 'all') throw new Error('Only the whole series can move to another calendar.');
    mutate([source, target], () => {
      moveComponents(source.vcalendar, target.vcalendar, event.uid);
      editSeries(target.vcalendar, ref, draft, timeZone);
    });
    return;
  }
  mutate([source], () => {
    if (scope === 'this') {
      editOccurrence(source.vcalendar, ref, { ...draft, rrule: undefined }, timeZone);
    } else if (scope === 'following') {
      editFollowing(source.vcalendar, ref, draft, timeZone);
    } else {
      editSeries(source.vcalendar, ref, draft, timeZone);
    }
  });
}

export function deleteEvent(event: AgendaEvent, scope: EditScope = 'all'): void {
  const calendar = requireEditable(event.calendarFileId);
  mutate([calendar], () => {
    if (!event.recurrenceId) removeEvent(calendar.vcalendar, event.uid);
    else if (!event.recurring || scope === 'this') {
      deleteOccurrence(calendar.vcalendar, occurrenceRef(event));
    } else if (scope === 'following') {
      deleteFollowing(calendar.vcalendar, occurrenceRef(event));
    } else removeEvent(calendar.vcalendar, event.uid);
  });
}

// ---------------------------------------------------------------------------------------------
// Calendars

/** "Work: Q1/Q2" → "Work- Q1-Q2.ics", unique within the folder. */
function fileNameFor(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Calendar';
  const taken = new Set(state.calendars.map((c) => c.name.toLowerCase()));
  let candidate = `${base}.ics`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} (${i}).ics`;
  return candidate;
}

/** Creates a new, empty .ics file in the folder and returns its file ID. */
export async function createCalendar(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Please enter a name.');
  assertWritable();
  if (!state.folderId) throw new Error('Load a folder from Google Drive first.');
  const generation = loadGeneration;
  const content = serializeCalendar(newCalendarComponent(trimmed));
  const meta: FileMeta = await storage().create(state.folderId, fileNameFor(trimmed), content);
  if (generation !== loadGeneration) return meta.id;
  const calendar = toCalendarFile(meta, content);
  setState({
    calendars: [...state.calendars, calendar].sort(byName),
    warnings: state.warnings.filter((w) => !w.startsWith('No .ics files')),
  });
  return meta.id;
}

/** Renames a calendar (its X-WR-CALNAME; the file name on Drive stays the same). */
export function renameCalendar(fileId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Please enter a name.');
  assertWritable();
  const calendar = requireCalendar(fileId);
  mutate([calendar], () => {
    renameCalendarComponent(calendar.vcalendar, trimmed);
    calendar.displayName = trimmed;
  });
}

// ---------------------------------------------------------------------------------------------
// Subscriptions (online calendars copied into the folder)

export function subscriptionOf(fileId: string): SubscriptionInfo | null {
  const calendar = findCalendar(fileId);
  return calendar ? subscriptionInfo(calendar.vcalendar) : null;
}

/**
 * Subscribes to an online calendar: downloads it, then stores it as a new .ics file in the folder
 * with its source URL and download time. Returns the new file ID.
 */
export async function subscribeCalendar(name: string, link: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Please enter a name.');
  const url = normalizeSubscriptionUrl(link);
  assertWritable();
  if (!state.folderId) throw new Error('Load a folder from Google Drive first.');
  const folderId = state.folderId;
  const generation = loadGeneration;
  const text = await fetchRemoteCalendar(url, getSettings().corsProxy);
  const content = serializeCalendar(buildSubscriptionCalendar(text, url, trimmed));
  const meta = await storage().create(folderId, fileNameFor(trimmed), content);
  if (generation !== loadGeneration) return meta.id;
  setState({
    calendars: [...state.calendars, toCalendarFile(meta, content)].sort(byName),
    warnings: state.warnings.filter((w) => !w.startsWith('No .ics files')),
  });
  return meta.id;
}

/**
 * Re-downloads a subscribed calendar and saves the new copy to Drive. Without `force`, only does
 * so when the copy is more than a day old. Returns 'fresh' when nothing needed to be done.
 */
export async function syncSubscription(
  fileId: string,
  options: { force?: boolean } = {},
): Promise<'updated' | 'fresh'> {
  assertWritable();
  let calendar = requireCalendar(fileId);
  let info = subscriptionInfo(calendar.vcalendar);
  if (!info) throw new Error(`"${calendar.displayName}" is not a subscribed calendar.`);
  if (!options.force && !isStale(info)) return 'fresh';
  if (state.refreshing.includes(fileId)) return 'fresh';

  const generation = loadGeneration;
  setState({ refreshing: [...state.refreshing, fileId] });
  try {
    // Another device may already have updated the copy on Drive: start from that one.
    const meta = await storage().getMeta(fileId);
    if (meta.modifiedTime !== calendar.modifiedTime) {
      await reloadCalendar(fileId);
      calendar = requireCalendar(fileId);
      info = subscriptionInfo(calendar.vcalendar) ?? info;
      if (!options.force && !isStale(info)) return 'fresh';
    }

    const text = await fetchRemoteCalendar(info.url, getSettings().corsProxy);
    if (generation !== loadGeneration) return 'fresh';
    const updated: CalendarFile = {
      ...calendar,
      vcalendar: buildSubscriptionCalendar(text, info.url, calendar.displayName),
      dirty: true,
    };
    editVersions.set(fileId, (editVersions.get(fileId) ?? 0) + 1);
    setState({ calendars: state.calendars.map((c) => (c.fileId === fileId ? updated : c)) });
    await requestSave(fileId);
    return 'updated';
  } finally {
    setState({ refreshing: state.refreshing.filter((id) => id !== fileId) });
  }
}

/** Updates every subscription whose copy is more than a day old (one at a time). */
export async function syncStaleSubscriptions(): Promise<void> {
  if (state.readOnly) return;
  const generation = loadGeneration;
  const stale = state.calendars.filter((c) => {
    const info = subscriptionInfo(c.vcalendar);
    return info && isStale(info);
  });
  for (const calendar of stale) {
    if (generation !== loadGeneration) return;
    try {
      await syncSubscription(calendar.fileId);
    } catch (err) {
      subscriptionErrorHandler(calendar, errorMessage(err));
    }
  }
}

export function setSubscriptionErrorHandler(
  handler: (calendar: CalendarFile, message: string) => void,
) {
  subscriptionErrorHandler = handler;
}

// ---------------------------------------------------------------------------------------------
// Saving

function updateSaveStatus(): void {
  let saveStatus: SaveStatus;
  let saveError: string | null = null;
  if (runningSaves.size > 0) saveStatus = 'saving';
  else if (saveErrors.size > 0) {
    saveStatus = 'error';
    saveError = [...saveErrors.values()][0] ?? null;
  } else if (state.calendars.some((c) => c.dirty)) saveStatus = 'unsaved';
  else saveStatus = savedOnce ? 'saved' : 'idle';
  if (saveStatus !== state.saveStatus || saveError !== state.saveError) {
    setState({ saveStatus, saveError });
  }
}

/** Saves a calendar if it has changes. Saves of the same file run one at a time. */
export function requestSave(fileId: string): Promise<void> {
  // Read-only: keep the changes (still dirty); they are saved when editing is possible again.
  if (state.readOnly) {
    updateSaveStatus();
    return Promise.resolve();
  }
  const running = runningSaves.get(fileId);
  if (running) {
    pendingResaves.add(fileId);
    return running;
  }
  const generation = loadGeneration;
  const job = runSave(fileId).finally(() => {
    runningSaves.delete(fileId);
    if (generation !== loadGeneration) return;
    if (pendingResaves.delete(fileId)) void requestSave(fileId);
    updateSaveStatus();
  });
  runningSaves.set(fileId, job);
  updateSaveStatus();
  return job;
}

async function runSave(fileId: string): Promise<void> {
  const calendar = findCalendar(fileId);
  if (!calendar?.dirty) return;
  const generation = loadGeneration;

  try {
    // Conflict detection: someone (another device, a sync tool…) changed the file since we
    // loaded or last saved it.
    const meta = await storage().getMeta(fileId);
    if (meta.modifiedTime !== calendar.modifiedTime) {
      const choice = await conflictHandler(calendar);
      if (generation !== loadGeneration || choice === 'later') return;
      if (choice === 'reload') {
        await reloadCalendar(fileId);
        return;
      }
    }

    const version = editVersions.get(fileId) ?? 0;
    const updated = await storage().upload(fileId, serializeCalendar(calendar.vcalendar));
    if (generation !== loadGeneration) return;
    calendar.modifiedTime = updated.modifiedTime;
    if ((editVersions.get(fileId) ?? 0) === version) calendar.dirty = false;
    else pendingResaves.add(fileId);
    saveErrors.delete(fileId);
    savedOnce = true;
  } catch (err) {
    if (generation !== loadGeneration) return;
    const message = errorMessage(err);
    saveErrors.set(fileId, message);
    saveErrorHandler(calendar, message);
  }
}

/** Retries every calendar that still has unsaved changes. */
export function retrySaves(): void {
  if (state.readOnly) return;
  saveErrors.clear();
  for (const calendar of state.calendars) if (calendar.dirty) void requestSave(calendar.fileId);
  updateSaveStatus();
}

export function hasUnsavedChanges(): boolean {
  return runningSaves.size > 0 || state.calendars.some((c) => c.dirty);
}

export function isCalendarDirty(fileId: string): boolean {
  return findCalendar(fileId)?.dirty ?? false;
}

/** Called when a save finds the file changed on Drive; must return the user's decision. */
export function setConflictHandler(handler: (calendar: CalendarFile) => Promise<ConflictChoice>) {
  conflictHandler = handler;
}

export function setSaveErrorHandler(handler: (calendar: CalendarFile, message: string) => void) {
  saveErrorHandler = handler;
}

export function onCalendarsChange(listener: CalendarListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
