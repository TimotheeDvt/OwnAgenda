import type { EventDraft } from '../ics/edit';
import {
  FREQUENCIES,
  rulesEqual,
  WEEKDAYS,
  type Frequency,
  type SimpleRule,
  type Weekday,
} from '../ics/rrule';
import { addDays, instantToWall, normalizeTime, wallToInstant } from '../util/dates';
import { chooseOption } from './choiceDialog';

export interface CalendarOption {
  fileId: string;
  displayName: string;
}

export interface EventDialogOptions {
  mode: 'create' | 'edit';
  calendars: CalendarOption[];
  calendarFileId: string;
  draft: EventDraft;
  timeZone: string;
  /** The current repeat rule; `custom` when it can't be edited here (it is then kept as-is). */
  rule?: { rule: SimpleRule | null; custom: boolean };
  /** Editing one occurrence of a series: the caller asks which occurrences a change applies to. */
  occurrence?: boolean;
}

/** `draft.rrule` is undefined when the repeat settings were not changed. */
export type EventDialogResult =
  { action: 'save'; calendarFileId: string; draft: EventDraft } | { action: 'delete' } | null;

const DEFAULT_START_TIME = '09:00';
const DEFAULT_END_TIME = '10:00';

const UNITS: Record<Frequency, [string, string]> = {
  DAILY: ['day', 'days'],
  WEEKLY: ['week', 'weeks'],
  MONTHLY: ['month', 'months'],
  YEARLY: ['year', 'years'],
};
const FREQ_LABELS: Record<Frequency, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  YEARLY: 'Yearly',
};
const WEEKDAY_LABELS: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};
/** JS getUTCDay() index (0 = Sunday) → RRULE weekday. */
const JS_DAY_TO_WEEKDAY: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function weekdayOf(date: string): Weekday {
  return JS_DAY_TO_WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? 'MO';
}

/** A weekly rule without days repeats on the start's weekday: make that explicit to compare. */
function normalizeRule(rule: SimpleRule | null, startDate: string): SimpleRule | null {
  if (!rule) return null;
  const byDay =
    rule.freq === 'WEEKLY' && rule.byDay.length === 0 ? [weekdayOf(startDate)] : rule.byDay;
  return { ...rule, byDay: rule.freq === 'WEEKLY' ? byDay : [] };
}

/** Initial input values, in the display timezone. All-day end dates are shown inclusive. */
function initialValues(draft: EventDraft, timeZone: string) {
  if (draft.allDay) {
    const lastDay = addDays(draft.end, -1);
    return {
      startDate: draft.start,
      endDate: lastDay < draft.start ? draft.start : lastDay,
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
  const { mode, calendars, draft, timeZone } = options;
  const initialRule = options.rule ?? { rule: null, custom: false };
  const id = `event-dialog-${++counter}`;

  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'event-dialog';
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.innerHTML = `
      <form class="event-form" novalidate>
        <h2 id="${id}-title"></h2>
        <label class="field">Title
          <input name="title" class="title-input" type="text" autocomplete="off" />
        </label>
        <label class="field">Calendar
          <select name="calendar"></select>
        </label>
        <label class="checkbox"><input name="allDay" type="checkbox" /> Full day</label>
        <div class="field">Start
          <div class="datetime-row">
            <input name="startDate" type="date" aria-label="Start date" required />
            <input name="startTime" class="time-input" type="text" inputmode="numeric" placeholder="HH:MM" maxlength="5" autocomplete="off" aria-label="Start time (24-hour, HH:MM)" />
          </div>
        </div>
        <div class="field">End
          <div class="datetime-row">
            <input name="endDate" type="date" aria-label="End date" required />
            <input name="endTime" class="time-input" type="text" inputmode="numeric" placeholder="HH:MM" maxlength="5" autocomplete="off" aria-label="End time (24-hour, HH:MM)" />
          </div>
        </div>
        <label class="field">Repeat
          <select name="freq">
            <option value="">Does not repeat</option>
            ${FREQUENCIES.map((f) => `<option value="${f}">${FREQ_LABELS[f]}</option>`).join('')}
            <option value="custom">Custom rule (kept as is)</option>
          </select>
        </label>
        <div class="repeat-options">
          <label class="inline-field">Every
            <input name="interval" type="number" min="1" max="999" step="1" />
            <span class="interval-unit"></span>
          </label>
          <div class="weekdays" role="group" aria-label="Repeat on">
            ${WEEKDAYS.map(
              (d) =>
                `<label class="weekday"><input type="checkbox" name="byDay" value="${d}" />` +
                `<span>${WEEKDAY_LABELS[d]}</span></label>`,
            ).join('')}
          </div>
          <div class="inline-field">Ends
            <select name="endType" aria-label="Ends">
              <option value="never">Never</option>
              <option value="until">On date</option>
              <option value="count">After</option>
            </select>
            <input name="until" type="date" aria-label="End date of the series" />
            <input name="count" type="number" min="1" max="9999" step="1" aria-label="Occurrences" />
            <span class="count-unit">times</span>
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
    const freq = field<HTMLSelectElement>('freq');
    const interval = field<HTMLInputElement>('interval');
    const endType = field<HTMLSelectElement>('endType');
    const until = field<HTMLInputElement>('until');
    const count = field<HTMLInputElement>('count');
    const dayBoxes = [...form.querySelectorAll<HTMLInputElement>('input[name="byDay"]')];
    const location = field<HTMLInputElement>('location');
    const description = field<HTMLTextAreaElement>('description');
    const error = form.querySelector<HTMLElement>('.form-error')!;
    const deleteBtn = form.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
    const cancelBtn = form.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;

    dialog.querySelector('h2')!.textContent = mode === 'create' ? 'New event' : 'Edit event';

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

    // Repeat settings.
    const shownRule = normalizeRule(initialRule.rule, values.startDate);
    const customOption = freq.querySelector<HTMLOptionElement>('option[value="custom"]')!;
    customOption.hidden = !initialRule.custom;
    freq.value = initialRule.custom ? 'custom' : (shownRule?.freq ?? '');
    interval.value = String(shownRule?.interval ?? 1);
    for (const box of dayBoxes)
      box.checked = shownRule?.byDay.includes(box.value as Weekday) ?? false;
    endType.value = shownRule?.end.type ?? 'never';
    until.value =
      shownRule?.end.type === 'until' ? shownRule.end.date : addDays(values.startDate, 30);
    count.value = String(shownRule?.end.type === 'count' ? shownRule.end.count : 10);

    const syncRepeat = () => {
      const f = freq.value as Frequency | '' | 'custom';
      const active = f !== '' && f !== 'custom';
      form.classList.toggle('repeating', active);
      form.classList.toggle('weekly', f === 'WEEKLY');
      form.classList.toggle('ends-until', endType.value === 'until');
      form.classList.toggle('ends-count', endType.value === 'count');
      if (active) {
        const [one, many] = UNITS[f];
        form.querySelector('.interval-unit')!.textContent =
          Number(interval.value) === 1 ? one : many;
      }
      if (f === 'WEEKLY' && !dayBoxes.some((b) => b.checked)) {
        const day = weekdayOf(startDate.value || values.startDate);
        dayBoxes.forEach((b) => (b.checked = b.value === day));
      }
    };
    for (const el of [freq, interval, endType]) el.addEventListener('input', syncRepeat);
    syncRepeat();

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
    // Time fields are 24-hour text inputs (native time pickers may show AM/PM): tidy "930" or
    // "9:30" into "09:30" when leaving the field.
    for (const input of [startTime, endTime]) {
      input.addEventListener('change', () => {
        input.value = normalizeTime(input.value) ?? input.value;
      });
    }
    startDate.addEventListener('change', shiftEnd);
    startTime.addEventListener('change', shiftEnd);

    deleteBtn.hidden = mode !== 'edit';

    const showError = (message: string) => {
      error.textContent = message;
      error.hidden = false;
    };

    /** undefined = unchanged, null = no repeat, or the new rule. Throws if the input is invalid. */
    const readRule = (): SimpleRule | null | undefined => {
      const f = freq.value;
      if (f === 'custom') return undefined;
      let rule: SimpleRule | null = null;
      if (f) {
        const n = Number(interval.value);
        if (!Number.isInteger(n) || n < 1)
          throw new Error('Please enter how often the event repeats.');
        const end =
          endType.value === 'until'
            ? { type: 'until' as const, date: until.value }
            : endType.value === 'count'
              ? { type: 'count' as const, count: Number(count.value) }
              : { type: 'never' as const };
        if (end.type === 'until' && (!end.date || end.date < startDate.value)) {
          throw new Error('The repeat end date must be after the start.');
        }
        if (end.type === 'count' && (!Number.isInteger(end.count) || end.count < 1)) {
          throw new Error('Please enter how many times the event repeats.');
        }
        rule = {
          freq: f as Frequency,
          interval: n,
          byDay:
            f === 'WEEKLY' ? dayBoxes.filter((b) => b.checked).map((b) => b.value as Weekday) : [],
          end,
        };
      }
      const unchanged = initialRule.custom
        ? false
        : rulesEqual(
            normalizeRule(rule, startDate.value),
            normalizeRule(initialRule.rule, startDate.value),
          );
      return unchanged ? undefined : rule;
    };

    const readDraft = (): EventDraft | null => {
      if (!startDate.value || !endDate.value) {
        showError('Please enter a start and end date.');
        return null;
      }
      let rrule: SimpleRule | null | undefined;
      try {
        rrule = readRule();
      } catch (err) {
        showError((err as Error).message);
        return null;
      }
      const base = {
        title: title.value.trim(),
        location: location.value.trim() || undefined,
        description: description.value.trim() || undefined,
        ...(rrule !== undefined ? { rrule } : {}),
      };
      if (allDay.checked) {
        if (endDate.value < startDate.value) {
          showError('The end date is before the start date.');
          return null;
        }
        return { ...base, allDay: true, start: startDate.value, end: addDays(endDate.value, 1) };
      }
      const startClock = normalizeTime(startTime.value);
      const endClock = normalizeTime(endTime.value);
      if (!startClock || !endClock) {
        showError('Please enter start and end times as HH:MM (24-hour), e.g. 09:30 or 18:00.');
        return null;
      }
      const start = wallToInstant(startDate.value, startClock, timeZone);
      const end = wallToInstant(endDate.value, endClock, timeZone);
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
      const value = readDraft();
      if (!value) return;
      result = { action: 'save', calendarFileId: calendar.value, draft: value };
      dialog.close();
    });
    cancelBtn.addEventListener('click', () => dialog.close());
    deleteBtn.addEventListener('click', async () => {
      // For occurrences of a series, the "which events?" question that follows is the confirmation.
      if (!options.occurrence) {
        const choice = await chooseOption(
          'Delete event?',
          `"${draft.title || 'This event'}" will be removed from the calendar file.`,
          [
            { value: 'cancel', label: 'Cancel' },
            { value: 'delete', label: 'Delete', kind: 'danger' },
          ],
        );
        if (choice !== 'delete') return;
      }
      result = { action: 'delete' };
      dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    title.focus();
  });
}
