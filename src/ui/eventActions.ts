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
  ruleOfEvent,
  subscriptionOf,
} from '../store/calendarStore';
import { getCalendarSettings, getSettings } from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { instantToWall, wallToInstant } from '../util/dates';
import { chooseOption, type Choice } from './choiceDialog';
import { openEventDialog, type CalendarOption } from './eventDialog';
import { showToast } from './toast';

/** New start/end of an event, in EventDraft format (dates for all-day, ISO instants otherwise). */
export type EventTimes = Pick<EventDraft, 'allDay' | 'start' | 'end'>;

/** Calendars events can be added to or moved to (subscribed calendars are read-only). */
function calendarOptions(): CalendarOption[] {
  return getCalendarState()
    .calendars.filter((c) => !subscriptionOf(c.fileId))
    .map(({ fileId, displayName }) => ({ fileId, displayName }));
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

/** Opens the dialog for an existing event, then applies the edit or deletion. */
export async function openEvent(event: AgendaEvent): Promise<void> {
  const subscription = subscriptionOf(event.calendarFileId);
  if (subscription) {
    const calendar = getCalendarState().calendars.find((c) => c.fileId === event.calendarFileId);
    await openEventDialog({
      mode: 'edit',
      calendars: calendar ? [{ fileId: calendar.fileId, displayName: calendar.displayName }] : [],
      calendarFileId: event.calendarFileId,
      draft: eventToDraft(event),
      timeZone: getSettings().timeZone,
      rule: event.recurring ? ruleOfEvent(event) : undefined,
      readOnlyNote:
        `This event comes from a subscribed online calendar (${new URL(subscription.url).host}). ` +
        "It is updated from there every day and can't be edited here.",
    });
    return;
  }
  const result = await openEventDialog({
    mode: 'edit',
    calendars: calendarOptions(),
    calendarFileId: event.calendarFileId,
    draft: eventToDraft(event),
    timeZone: getSettings().timeZone,
    rule: event.recurring ? ruleOfEvent(event) : undefined,
    occurrence: event.recurring,
  });
  if (!result) return;

  if (result.action === 'delete') {
    let scope: EditScope = 'all';
    if (event.recurring) {
      const chosen = await chooseScope('delete', { this: true, following: true });
      if (!chosen) return;
      scope = chosen;
    }
    if (run(() => deleteEvent(event, scope))) showToast('Event deleted.');
    return;
  }

  const targetFileId = result.calendarFileId;
  if (!event.recurring) {
    run(() => editEvent(event, result.draft, { targetFileId }));
    return;
  }
  const moving = targetFileId !== event.calendarFileId;
  const ruleChanged = result.draft.rrule !== undefined;
  const scope = await chooseScope('edit', { this: !moving && !ruleChanged, following: !moving });
  if (scope) run(() => editEvent(event, result.draft, { scope, targetFileId }));
}

/** Applies a drag & drop move or a resize. Resolves false if cancelled or failed (to revert). */
export async function changeEventTimes(event: AgendaEvent, times: EventTimes): Promise<boolean> {
  const draft = { ...eventToDraft(event), ...times };
  if (!event.recurring) return run(() => editEvent(event, draft));
  const scope = await chooseScope('edit', { this: true, following: true });
  if (!scope) return false;
  return run(() => editEvent(event, draft, { scope }));
}
