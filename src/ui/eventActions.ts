import type { EventDraft } from '../ics/edit';
import type { EditScope } from '../ics/recurringEdit';
import {
  addEvent,
  calendarIndex,
  deleteEvent,
  editEvent,
  errorMessage,
  eventToDraft,
  getCalendarState,
  readOnlyMessage,
  redo,
  ruleOfEvent,
  subscriptionOf,
  undo,
  type EditOptions,
} from '../store/calendarStore';
import {
  forgetGhostEvents,
  isGhostEvent,
  moveGhostEvent,
  setGhostEvent,
} from '../store/ghostEvents';
import { getCalendarSettings, getSettings, orderCalendars } from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { instantToWall, wallToInstant } from '../util/dates';
import { chooseOption, type Choice } from './choiceDialog';
import { openContextMenu } from './contextMenu';
import { openEventDialog, type CalendarOption } from './eventDialog';
import { openEventView } from './eventView';
import { showToast } from './toast';

/** New start/end of an event, in EventDraft format (dates for all-day, ISO instants otherwise). */
export type EventTimes = Pick<EventDraft, 'allDay' | 'start' | 'end'>;

function toOption({ fileId, displayName }: { fileId: string; displayName: string }) {
  const { color, icon } = getCalendarSettings(fileId, calendarIndex(fileId));
  return { fileId, displayName, color, icon };
}

/** Calendars events can be added to or moved to (subscribed calendars are read-only). */
function calendarOptions(): CalendarOption[] {
  return orderCalendars(getCalendarState().calendars)
    .filter((c) => !subscriptionOf(c.fileId))
    .map(toOption);
}

function run(action: () => void): boolean {
  try {
    action();
    return true;
  } catch (err) {
    showToast(errorMessage(err), 'error');
    return false;
  }
}

/** Asks which occurrences of a series a change applies to. Null if cancelled. */
async function chooseScope(
  action: 'edit' | 'delete',
  allow: { this: boolean; following: boolean },
): Promise<EditScope | null> {
  const choices: Choice<EditScope | 'cancel'>[] = [{ value: 'cancel', label: 'Cancel' }];
  if (allow.this) choices.push({ value: 'this', label: 'This event' });
  if (allow.following) choices.push({ value: 'following', label: 'This and following' });
  choices.push({
    value: 'all',
    label: 'All events',
    kind: action === 'delete' ? 'danger' : 'primary',
  });
  const choice = await chooseOption(
    action === 'delete' ? 'Delete recurring event' : 'Edit recurring event',
    action === 'delete'
      ? 'This event repeats. Which occurrences do you want to delete?'
      : 'This event repeats. Which occurrences should the change apply to?',
    choices,
  );
  return choice && choice !== 'cancel' ? choice : null;
}

/** Opens the dialog for a new event over the selected range. */
export async function createEventAt(times: EventTimes): Promise<void> {
  const readOnly = getCalendarState().readOnly;
  if (readOnly) {
    showToast(readOnlyMessage(readOnly), 'warning');
    return;
  }
  const calendars = calendarOptions();
  if (calendars.length === 0) {
    showToast(
      'There is no editable calendar to add the event to. Create one in the sidebar first.',
    );
    return;
  }
  const firstVisible = calendars.find(
    (c) => getCalendarSettings(c.fileId, calendarIndex(c.fileId)).visible,
  );
  const result = await openEventDialog({
    mode: 'create',
    calendars,
    calendarFileId: (firstVisible ?? calendars[0]!).fileId,
    draft: { title: '', ...times },
    timeZone: getSettings().timeZone,
  });
  if (result?.action === 'save') run(() => addEvent(result.calendarFileId, result.draft));
}

/** New one-hour event starting at the next full hour (keyboard shortcut). */
export function createEventNow(): Promise<void> {
  const { timeZone } = getSettings();
  const now = instantToWall(Date.now(), timeZone);
  const hour = Number(now.time.slice(0, 2));
  const start =
    wallToInstant(now.date, `${String(hour).padStart(2, '0')}:00`, timeZone) + 3_600_000;
  return createEventAt({
    allDay: false,
    start: new Date(start).toISOString(),
    end: new Date(start + 3_600_000).toISOString(),
  });
}

/**
 * Opens a "new event" dialog prefilled with a copy of an event (its current values in the dialog,
 * repeat rule included), in the same calendar when it can be edited.
 */
async function duplicateEvent(calendarFileId: string, draft: EventDraft): Promise<void> {
  const calendars = calendarOptions();
  if (calendars.length === 0) {
    showToast(
      'There is no editable calendar to copy the event to. Create one in the sidebar first.',
    );
    return;
  }
  const target = calendars.find((c) => c.fileId === calendarFileId) ?? calendars[0]!;
  const { rrule, ...fields } = draft;
  const result = await openEventDialog({
    mode: 'create',
    heading: 'Duplicate event',
    calendars,
    calendarFileId: target.fileId,
    draft: fields,
    timeZone: getSettings().timeZone,
    rule: rrule ? { rule: rrule, custom: false } : undefined,
  });
  if (result?.action === 'save' && run(() => addEvent(result.calendarFileId, result.draft))) {
    showToast('Event duplicated.');
  }
}

/**
 * Shows an event (read-only view). From there, the pen opens the edit dialog (not for subscribed
 * calendars or while read-only) and Duplicate opens a "new event" dialog with a copy.
 */
export async function openEvent(event: AgendaEvent): Promise<void> {
  const subscription = subscriptionOf(event.calendarFileId);
  const readOnly = getCalendarState().readOnly;
  const calendar = getCalendarState().calendars.find((c) => c.fileId === event.calendarFileId);
  const draft = eventToDraft(event);
  const rule = event.recurring ? ruleOfEvent(event) : undefined;
  const choice = await openEventView({
    draft,
    timeZone: getSettings().timeZone,
    calendar: calendar ? toOption(calendar) : undefined,
    rule,
    note: readOnly ? readOnlyMessage(readOnly) : undefined,
    readOnlyTag: subscription
      ? `From a subscribed online calendar (${new URL(subscription.url).host}), updated from ` +
        "there every day: it can't be edited here."
      : undefined,
    canEdit: !subscription && !readOnly,
    onDelete: () => confirmAndDelete(event),
    ghost: { value: isGhostEvent(event), onToggle: (ghost) => setGhostEvent(event, ghost) },
    // A subscribed event can still be copied into one of your calendars (not while offline).
    canDuplicate: !readOnly,
  });
  if (choice === 'duplicate') {
    await duplicateExistingEvent(event);
  } else if (choice === 'edit') {
    await editExistingEvent(event);
  }
}

/** The copy repeats like the original (unless its rule is too complex for the editor). */
function duplicateExistingEvent(event: AgendaEvent): Promise<void> {
  const rule = event.recurring ? ruleOfEvent(event) : undefined;
  return duplicateEvent(event.calendarFileId, {
    ...eventToDraft(event),
    rrule: rule && !rule.custom ? rule.rule : null,
  });
}

/**
 * "Mon 27 Oct 2026, 09:00 – 10:00" (all-day: "Mon 27 Oct 2026", or a range of days).
 * `compact` (tooltips): short dates ("27/10/26"), and none when the event starts and ends the
 * same day ("09:00 – 10:00", "All day").
 */
export function formatWhen(event: AgendaEvent, timeZone: string, compact = false): string {
  const date = (d: Date, zone: string) =>
    d.toLocaleDateString(
      'en-GB',
      compact
        ? { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: zone }
        : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: zone },
    );
  if (event.allDay) {
    // All-day dates are midnight UTC; the end is exclusive.
    const last = new Date(event.end.getTime() - 86_400_000);
    const first = date(event.start, 'UTC');
    if (last > event.start) return `${first} – ${date(last, 'UTC')}`;
    return compact ? 'All day' : first;
  }
  const time = (d: Date) =>
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
  const sameDay = date(event.start, timeZone) === date(event.end, timeZone);
  if (sameDay && compact) return `${time(event.start)} – ${time(event.end)}`;
  return sameDay
    ? `${date(event.start, timeZone)}, ${time(event.start)} – ${time(event.end)}`
    : `${date(event.start, timeZone)}, ${time(event.start)} – ${date(event.end, timeZone)}, ${time(event.end)}`;
}

/** Copies the event as text (title, when, where, notes), e.g. to paste it in a message. */
function copyEventDetails(event: AgendaEvent): void {
  const text = [
    event.title || '(No title)',
    formatWhen(event, getSettings().timeZone),
    event.location,
    event.description,
  ]
    .filter(Boolean)
    .join('\n');
  navigator.clipboard.writeText(text).then(
    () => showToast('Event details copied.'),
    () => showToast("Couldn't copy to the clipboard.", 'error'),
  );
}

/**
 * Right-click menu of an event: Open, Edit, Duplicate, Ghost, Copy details, Delete. Edit and
 * Delete are greyed out for subscribed calendars and while changes can't be saved.
 */
export function openEventMenu(event: AgendaEvent, x: number, y: number): void {
  const subscription = subscriptionOf(event.calendarFileId);
  const readOnly = getCalendarState().readOnly;
  const why = readOnly
    ? readOnlyMessage(readOnly)
    : subscription
      ? "Events of subscribed online calendars can't be changed here."
      : undefined;
  const canEdit = !subscription && !readOnly;
  const ghost = isGhostEvent(event);
  openContextMenu(
    x,
    y,
    [
      { label: 'Open', icon: 'eye', key: 'O', onSelect: () => void openEvent(event) },
      {
        label: 'Edit',
        icon: 'edit',
        key: 'E',
        disabled: !canEdit,
        title: why,
        onSelect: () => void editExistingEvent(event),
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        key: 'D',
        // A subscribed event can still be copied into one of your calendars (not while offline).
        disabled: readOnly !== null,
        title: readOnly ? readOnlyMessage(readOnly) : undefined,
        onSelect: () => void duplicateExistingEvent(event),
      },
      {
        label: ghost ? 'Unghost' : 'Ghost',
        icon: 'ghost',
        key: 'G',
        title: ghost ? 'Show normally (remove ghost)' : 'Make ghost (fade it)',
        onSelect: () => setGhostEvent(event, !ghost),
      },
      {
        label: 'Copy details',
        icon: 'clipboard',
        key: 'C',
        onSelect: () => copyEventDetails(event),
      },
      null,
      {
        label: 'Delete',
        icon: 'trash',
        key: 'Delete',
        danger: true,
        disabled: !canEdit,
        title: why,
        onSelect: () => void confirmAndDelete(event),
      },
    ],
    event.title || 'Event',
  );
}

/** Asks for confirmation (which occurrences, for a series), then deletes. True if deleted. */
async function confirmAndDelete(event: AgendaEvent): Promise<boolean> {
  let scope: EditScope = 'all';
  if (event.recurring) {
    const chosen = await chooseScope('delete', { this: true, following: true });
    if (!chosen) return false;
    scope = chosen;
  } else {
    const choice = await chooseOption(
      'Delete event?',
      `"${event.title || 'This event'}" will be removed from the calendar file.`,
      [
        { value: 'cancel', label: 'Cancel' },
        { value: 'delete', label: 'Delete', kind: 'danger' },
      ],
    );
    if (choice !== 'delete') return false;
  }
  return removeEvent(event, scope);
}

/** Deletes (with its ghost, see ghostEvents.ts). True if deleted. */
function removeEvent(event: AgendaEvent, scope: EditScope): boolean {
  if (!run(() => deleteEvent(event, scope))) return false;
  forgetGhostEvents(event, event.recurring && scope !== 'this' ? scope : undefined);
  showToast('Event deleted.');
  return true;
}

/** Applies an edit; a ghosted event stays ghosted at its new time / in its new calendar. */
function applyEdit(event: AgendaEvent, draft: EventDraft, options: EditOptions = {}): boolean {
  if (!run(() => editEvent(event, draft, options))) return false;
  // Edits of a whole series can change the occurrences' ids: only follow a single occurrence.
  if (!event.recurring || options.scope === 'this') {
    const { timeZone } = getSettings();
    const instant = (value: string) =>
      draft.allDay ? wallToInstant(value, '00:00', timeZone) : Date.parse(value);
    moveGhostEvent(
      event,
      { start: instant(draft.start), end: instant(draft.end) },
      options.targetFileId ?? event.calendarFileId,
    );
  }
  return true;
}

/** Opens the edit dialog for an event, then applies the edit, deletion or duplication. */
async function editExistingEvent(event: AgendaEvent): Promise<void> {
  const result = await openEventDialog({
    mode: 'edit',
    calendars: calendarOptions(),
    calendarFileId: event.calendarFileId,
    draft: eventToDraft(event),
    timeZone: getSettings().timeZone,
    rule: event.recurring ? ruleOfEvent(event) : undefined,
    occurrence: event.recurring,
    canDuplicate: true,
  });
  if (!result) return;
  if (result.action === 'duplicate') {
    await duplicateEvent(result.calendarFileId, result.draft);
    return;
  }

  if (result.action === 'delete') {
    let scope: EditScope = 'all';
    if (event.recurring) {
      const chosen = await chooseScope('delete', { this: true, following: true });
      if (!chosen) return;
      scope = chosen;
    }
    removeEvent(event, scope);
    return;
  }

  const targetFileId = result.calendarFileId;
  if (!event.recurring) {
    applyEdit(event, result.draft, { targetFileId });
    return;
  }
  const moving = targetFileId !== event.calendarFileId;
  const ruleChanged = result.draft.rrule !== undefined;
  const scope = await chooseScope('edit', { this: !moving && !ruleChanged, following: !moving });
  if (scope) applyEdit(event, result.draft, { scope, targetFileId });
}

/** Applies a drag & drop move or a resize. Resolves false if cancelled or failed (to revert). */
export async function changeEventTimes(event: AgendaEvent, times: EventTimes): Promise<boolean> {
  const draft = { ...eventToDraft(event), ...times };
  if (!event.recurring) return applyEdit(event, draft);
  const scope = await chooseScope('edit', { this: true, following: true });
  if (!scope) return false;
  return applyEdit(event, draft, { scope });
}

/** Undo button / Ctrl+Z: reverts the last change and says which. */
export function undoLastChange(): void {
  run(() => {
    const label = undo();
    if (label) showToast(`Undone: ${label}`);
  });
}

/** Redo button / Ctrl+Y: applies the last undone change again. */
export function redoLastChange(): void {
  run(() => {
    const label = redo();
    if (label) showToast(`Redone: ${label}`);
  });
}
