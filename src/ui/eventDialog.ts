import type { EventDraft } from '../ics/edit';
import { addDays, instantToWall, wallToInstant } from '../util/dates';
import { chooseOption } from './choiceDialog';

export interface CalendarOption {
  fileId: string;
  displayName: string;
}

export interface EventDialogOptions {
  mode: 'create' | 'edit';
  /** Recurring events can't be edited yet: fields are shown disabled. */
  readOnly?: boolean;
  calendars: CalendarOption[];
  calendarFileId: string;
  draft: EventDraft;
  timeZone: string;
}

export type EventDialogResult =
  { action: 'save'; calendarFileId: string; draft: EventDraft } | { action: 'delete' } | null;

const DEFAULT_START_TIME = '09:00';
const DEFAULT_END_TIME = '10:00';

/** Initial input values, in the display timezone. All-day end dates are shown inclusive. */
function initialValues(draft: EventDraft, timeZone: string) {
  if (draft.allDay) {
    return {
      startDate: draft.start,
      endDate: addDays(draft.end, -1) < draft.start ? draft.start : addDays(draft.end, -1),
      startTime: DEFAULT_START_TIME,
      endTime: DEFAULT_END_TIME,
    };
  }
  const start = instantToWall(Date.parse(draft.start), timeZone);
  const end = instantToWall(Date.parse(draft.end), timeZone);
  return { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time };
}

let counter = 0;

export function openEventDialog(options: EventDialogOptions): Promise<EventDialogResult> {
  const { mode, readOnly = false, calendars, draft, timeZone } = options;
  const id = `event-dialog-${++counter}`;

  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'event-dialog';
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.innerHTML = `
      <form class="event-form" novalidate>
        <h2 id="${id}-title"></h2>
        <p class="readonly-note" hidden>
          This is a recurring event. Editing recurring events will come in a later version.
        </p>
        <label class="field">Title
          <input name="title" class="title-input" type="text" autocomplete="off" />
        </label>
        <label class="field">Calendar
          <select name="calendar"></select>
        </label>
        <label class="checkbox"><input name="allDay" type="checkbox" /> All day</label>
        <div class="field">Start
          <div class="datetime-row">
            <input name="startDate" type="date" aria-label="Start date" required />
            <input name="startTime" class="time-input" type="time" aria-label="Start time" />
          </div>
        </div>
        <div class="field">End
          <div class="datetime-row">
            <input name="endDate" type="date" aria-label="End date" required />
            <input name="endTime" class="time-input" type="time" aria-label="End time" />
          </div>
        </div>
        <label class="field">Location
          <input name="location" type="text" autocomplete="off" />
        </label>
        <label class="field">Description
          <textarea name="description" rows="3"></textarea>
        </label>
        <p class="form-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button type="button" data-action="delete" class="btn btn-danger" hidden>Delete</button>
          <button type="button" data-action="cancel" class="btn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>`;

    const form = dialog.querySelector('form')!;
    const field = <T extends HTMLElement>(name: string) =>
      form.querySelector<T>(`[name="${name}"]`)!;
    const title = field<HTMLInputElement>('title');
    const calendar = field<HTMLSelectElement>('calendar');
    const allDay = field<HTMLInputElement>('allDay');
    const startDate = field<HTMLInputElement>('startDate');
    const startTime = field<HTMLInputElement>('startTime');
    const endDate = field<HTMLInputElement>('endDate');
    const endTime = field<HTMLInputElement>('endTime');
    const location = field<HTMLInputElement>('location');
    const description = field<HTMLTextAreaElement>('description');
    const error = form.querySelector<HTMLElement>('.form-error')!;
    const deleteBtn = form.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
    const cancelBtn = form.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    const saveBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    dialog.querySelector('h2')!.textContent =
      mode === 'create' ? 'New event' : readOnly ? 'Event' : 'Edit event';

    for (const cal of calendars) {
      const option = document.createElement('option');
      option.value = cal.fileId;
      option.textContent = cal.displayName;
      calendar.appendChild(option);
    }
    calendar.value = options.calendarFileId;

    const values = initialValues(draft, timeZone);
    title.value = draft.title;
    allDay.checked = draft.allDay;
    startDate.value = values.startDate;
    startTime.value = values.startTime;
    endDate.value = values.endDate;
    endTime.value = values.endTime;
    location.value = draft.location ?? '';
    description.value = draft.description ?? '';

    const syncAllDay = () => form.classList.toggle('all-day', allDay.checked);
    allDay.addEventListener('change', syncAllDay);
    syncAllDay();

    // Moving the start keeps the duration, like most calendar apps.
    let previousStart = { date: startDate.value, time: startTime.value };
    const shiftEnd = () => {
      if (allDay.checked) {
        const days = Math.round(
          (Date.parse(startDate.value) - Date.parse(previousStart.date)) / 86_400_000,
        );
        if (Number.isFinite(days) && endDate.value) endDate.value = addDays(endDate.value, days);
      } else {
        const before = wallToInstant(previousStart.date, previousStart.time, timeZone);
        const after = wallToInstant(startDate.value, startTime.value, timeZone);
        const end = wallToInstant(endDate.value, endTime.value, timeZone);
        if (![before, after, end].some(Number.isNaN)) {
          const wall = instantToWall(end + (after - before), timeZone);
          endDate.value = wall.date;
          endTime.value = wall.time;
        }
      }
      previousStart = { date: startDate.value, time: startTime.value };
    };
    startDate.addEventListener('change', shiftEnd);
    startTime.addEventListener('change', shiftEnd);

    if (readOnly) {
      form.querySelector<HTMLElement>('.readonly-note')!.hidden = false;
      for (const input of form.querySelectorAll<HTMLInputElement>('input, select, textarea')) {
        input.disabled = true;
      }
      saveBtn.hidden = true;
      cancelBtn.textContent = 'Close';
    }
    deleteBtn.hidden = mode !== 'edit' || readOnly;

    const showError = (message: string) => {
      error.textContent = message;
      error.hidden = false;
    };

    const readDraft = (): EventDraft | null => {
      if (!startDate.value || !endDate.value) {
        showError('Please enter a start and end date.');
        return null;
      }
      const base = {
        title: title.value.trim(),
        location: location.value.trim() || undefined,
        description: description.value.trim() || undefined,
      };
      if (allDay.checked) {
        if (endDate.value < startDate.value) {
          showError('The end date is before the start date.');
          return null;
        }
        return {
          ...base,
          allDay: true,
          start: startDate.value,
          end: addDays(endDate.value, 1),
        };
      }
      const start = wallToInstant(startDate.value, startTime.value, timeZone);
      const end = wallToInstant(endDate.value, endTime.value, timeZone);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        showError('Please enter a start and end time.');
        return null;
      }
      if (end < start) {
        showError('The end is before the start.');
        return null;
      }
      return {
        ...base,
        allDay: false,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      };
    };

    let result: EventDialogResult = null;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (readOnly) return;
      const value = readDraft();
      if (!value) return;
      result = { action: 'save', calendarFileId: calendar.value, draft: value };
      dialog.close();
    });
    cancelBtn.addEventListener('click', () => dialog.close());
    deleteBtn.addEventListener('click', async () => {
      const choice = await chooseOption(
        'Delete event?',
        `"${draft.title || 'This event'}" will be removed from the calendar file.`,
        [
          { value: 'cancel', label: 'Cancel' },
          { value: 'delete', label: 'Delete', kind: 'danger' },
        ],
      );
      if (choice !== 'delete') return;
      result = { action: 'delete' };
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    if (!readOnly) title.focus();
  });
}
