import { downloadFile, getFileMeta, listIcsFiles, resolvePath, uploadFile } from '../drive/files';
import { createEvent, findMasterEvent, moveEvent, removeEvent, updateEvent } from '../ics/edit';
import type { EventDraft } from '../ics/edit';
import { toCalendarFile } from '../ics/parse';
import { expandCalendar } from '../ics/recurrence';
import { serializeCalendar } from '../ics/serialize';
import type { AgendaEvent, CalendarFile, DateRange } from '../types';
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
  saveStatus: SaveStatus;
  saveError: string | null;
}

export type CalendarListener = (state: CalendarState) => void;
/** "later" keeps the changes unsaved; saving again asks again. */
export type ConflictChoice = 'reload' | 'overwrite' | 'later';

const initialState = (): CalendarState => ({
  status: 'idle',
  error: null,
  warnings: [],
  calendars: [],
  saveStatus: 'idle',
  saveError: null,
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

/**
 * Resolves the folder, then downloads and parses every .ics file in parallel. A file that fails
 * becomes a warning; the others still load. Unsaved changes are discarded.
 */
export async function loadCalendars(folderPath: string): Promise<void> {
  const generation = ++loadGeneration;
  resetSaveTracking();
  setState({ status: 'loading', error: null, warnings: [], saveStatus: 'idle', saveError: null });

  try {
    const folderId = await resolvePath(folderPath);
    const files = await listIcsFiles(folderId);
    const results = await Promise.allSettled(
      files.map(async (meta) => toCalendarFile(meta, await downloadFile(meta.id))),
    );
    if (generation !== loadGeneration) return;

    const calendars: CalendarFile[] = [];
    const warnings: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') calendars.push(result.value);
      else warnings.push(`${files[i]?.name ?? 'File'}: ${errorMessage(result.reason)}`);
    });
    if (files.length === 0) warnings.push(`No .ics files found in "${folderPath}".`);
    setState({ status: 'ready', calendars, warnings });
  } catch (err) {
    if (generation !== loadGeneration) return;
    setState({ status: 'error', error: errorMessage(err), calendars: [] });
  }
}

/** Re-downloads one calendar from Drive, discarding its local changes. */
export async function reloadCalendar(fileId: string): Promise<void> {
  const current = findCalendar(fileId);
  if (!current) return;
  const generation = loadGeneration;
  const meta = await getFileMeta(fileId);
  const fresh = toCalendarFile(meta, await downloadFile(fileId));
  if (generation !== loadGeneration) return;
  editVersions.delete(fileId);
  saveErrors.delete(fileId);
  pendingResaves.delete(fileId);
  setState({ calendars: state.calendars.map((c) => (c.fileId === fileId ? fresh : c)) });
  updateSaveStatus();
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

// ---------------------------------------------------------------------------------------------
// Editing

function requireCalendar(fileId: string): CalendarFile {
  const calendar = findCalendar(fileId);
  if (!calendar) throw new Error('That calendar is no longer loaded.');
  return calendar;
}

function assertNotRecurring(calendar: CalendarFile, uid: string): void {
  const vevent = findMasterEvent(calendar.vcalendar, uid);
  if (vevent && (vevent.hasProperty('rrule') || vevent.hasProperty('rdate'))) {
    throw new Error('Recurring events cannot be edited yet.');
  }
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

export function addEvent(fileId: string, draft: EventDraft): void {
  const calendar = requireCalendar(fileId);
  mutate([calendar], () => {
    createEvent(calendar.vcalendar, draft, getSettings().timeZone);
  });
}

/** Updates an event; when `targetFileId` differs, moves it to that calendar. */
export function editEvent(
  fileId: string,
  uid: string,
  draft: EventDraft,
  targetFileId: string = fileId,
): void {
  const source = requireCalendar(fileId);
  assertNotRecurring(source, uid);
  const timeZone = getSettings().timeZone;
  if (targetFileId === fileId) {
    mutate([source], () => updateEvent(source.vcalendar, uid, draft, timeZone));
    return;
  }
  const target = requireCalendar(targetFileId);
  mutate([source, target], () =>
    moveEvent(source.vcalendar, target.vcalendar, uid, draft, timeZone),
  );
}

export function deleteEvent(fileId: string, uid: string): void {
  const calendar = requireCalendar(fileId);
  assertNotRecurring(calendar, uid);
  mutate([calendar], () => {
    removeEvent(calendar.vcalendar, uid);
  });
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
    const meta = await getFileMeta(fileId);
    if (meta.modifiedTime !== calendar.modifiedTime) {
      const choice = await conflictHandler(calendar);
      if (generation !== loadGeneration || choice === 'later') return;
      if (choice === 'reload') {
        await reloadCalendar(fileId);
        return;
      }
    }

    const version = editVersions.get(fileId) ?? 0;
    const updated = await uploadFile(fileId, serializeCalendar(calendar.vcalendar));
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
  saveErrors.clear();
  for (const calendar of state.calendars) if (calendar.dirty) void requestSave(calendar.fileId);
  updateSaveStatus();
}

export function hasUnsavedChanges(): boolean {
  return runningSaves.size > 0 || state.calendars.some((c) => c.dirty);
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
