import type { EventDraft } from '../ics/edit';
import { describeRule, type SimpleRule } from '../ics/rrule';
import { addDays, instantToWall } from '../util/dates';
import { tidyDescription } from '../util/text';
import type { CalendarOption } from './eventDialog';
import { ICONS, type IconName } from './icons';

export interface EventViewOptions {
  draft: EventDraft;
  timeZone: string;
  /** The event's calendar (color, icon, name). */
  calendar?: CalendarOption;
  /** The event's repeat rule; `custom` when the editor can't show it. */
  rule?: { rule: SimpleRule | null; custom: boolean };
  /** Why the event can't be edited (subscribed calendar, offline...); shown under the details. */
  note?: string;
  /** Show a "Read only" tag in the top-right corner, with this explanation on hover. */
  readOnlyTag?: string;
  /** Show the pen (top-right corner) that switches to the edit dialog. */
  canEdit: boolean;
  /**
   * Shows the bin next to the pen. Asks for confirmation (over the view) and deletes; resolves
   * true when the event was deleted (the view then closes), false to stay on it.
   */
  onDelete?: () => Promise<boolean>;
  /** The ghost toggle (faded in the calendar): current state, and what to do when toggled. */
  ghost?: { value: boolean; onToggle(ghost: boolean): void };
  canDuplicate: boolean;
}

export type EventViewResult = 'edit' | 'duplicate' | null;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Text with its http(s) links made clickable (opened in a new tab). */
function linkify(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    const a = document.createElement('a');
    a.href = match[0];
    a.textContent = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nodes.push(a);
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

/** "Thursday 22 October" (long) or "Thu, 22 Oct"; the year only when it isn't this year's. */
function formatDay(date: string, long: boolean): string {
  const sameYear = date.slice(0, 4) === String(new Date().getFullYear());
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [days ? `${days} d` : '', h ? `${h} h` : '', m ? `${m} min` : ''];
  return parts.filter(Boolean).join(' ') || '0 min';
}

/** Date line and time line, in the display time zone (all-day end dates shown inclusive). */
function describeWhen(draft: EventDraft, timeZone: string): [string, string] {
  if (draft.allDay) {
    const lastDay = addDays(draft.end, -1);
    if (lastDay <= draft.start) return [formatDay(draft.start, true), 'Full day'];
    const days = Math.round((Date.parse(draft.end) - Date.parse(draft.start)) / 86_400_000);
    return [`${formatDay(draft.start, false)} – ${formatDay(lastDay, false)}`, `${days} days`];
  }
  const startMs = Date.parse(draft.start);
  const endMs = Date.parse(draft.end);
  const start = instantToWall(startMs, timeZone);
  const end = instantToWall(endMs, timeZone);
  const duration = formatDuration(endMs - startMs);
  if (start.date === end.date) {
    return [formatDay(start.date, true), `${start.time} – ${end.time} · ${duration}`];
  }
  return [
    `${formatDay(start.date, false)}, ${start.time} – ${formatDay(end.date, false)}, ${end.time}`,
    duration,
  ];
}

let counter = 0;

/**
 * Read-only view of an event: what, when, repeat, where, calendar and notes. The pen in the
 * top-right corner switches to the edit dialog; Duplicate copies the event into a new one.
 */
export function openEventView(options: EventViewOptions): Promise<EventViewResult> {
  const { draft, timeZone, calendar } = options;
  const id = `event-view-${++counter}`;

  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'event-dialog event-view';
    dialog.setAttribute('aria-labelledby', `${id}-title`);

    const header = document.createElement('div');
    header.className = 'event-view-header';
    const swatch = document.createElement('span');
    swatch.className = 'event-view-color';
    if (calendar) swatch.style.background = calendar.color;
    const title = document.createElement('h2');
    title.id = `${id}-title`;
    title.textContent = draft.title || '(No title)';
    header.append(swatch, title);

    let result: EventViewResult = null;
    const close = (value: EventViewResult) => {
      result = value;
      dialog.close();
    };

    const headerButton = (icon: IconName, className: string, label: string) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `icon-btn event-view-action ${className}`;
      btn.innerHTML = ICONS[icon];
      btn.title = label;
      btn.setAttribute('aria-label', label);
      header.append(btn);
      return btn;
    };

    // Ghost: on every event, even read-only ones (it is a display setting, not in the file).
    const ghostOption = options.ghost;
    if (ghostOption) {
      let ghost = ghostOption.value;
      const btn = headerButton('ghost', 'event-view-ghost', '');
      const sync = () => {
        const label = ghost ? 'Show normally (remove ghost)' : 'Make ghost (fade it)';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', String(ghost));
        dialog.classList.toggle('is-ghost', ghost);
      };
      btn.addEventListener('click', () => {
        ghost = !ghost;
        ghostOption.onToggle(ghost);
        sync();
      });
      sync();
    }

    if (options.canEdit) {
      const onDelete = options.onDelete;
      if (onDelete) {
        headerButton('trash', 'event-view-delete', 'Delete event').addEventListener(
          'click',
          async () => {
            if (await onDelete()) close(null);
          },
        );
      }
      const edit = headerButton('edit', 'event-view-edit', 'Edit event');
      edit.title = 'Edit event (E)';
      edit.addEventListener('click', () => close('edit'));
    } else if (options.readOnlyTag) {
      const tag = document.createElement('span');
      tag.className = 'event-view-tag';
      tag.textContent = 'Read only';
      tag.title = options.readOnlyTag;
      header.append(tag);
    }

    const details = document.createElement('div');
    details.className = 'event-view-details';
    const row = (icon: IconName, label: string, ...content: (Node | string)[]) => {
      const item = document.createElement('div');
      item.className = 'event-view-row';
      const glyph = document.createElement('span');
      glyph.className = 'event-view-icon';
      glyph.innerHTML = ICONS[icon];
      const body = document.createElement('div');
      body.className = 'event-view-body';
      body.setAttribute('aria-label', label);
      body.append(...content);
      item.append(glyph, body);
      details.append(item);
      return body;
    };

    const [dateLine, timeLine] = describeWhen(draft, timeZone);
    const time = document.createElement('div');
    time.className = 'event-view-muted';
    time.textContent = timeLine;
    row('clock', 'When', dateLine, time);

    const rule = options.rule;
    if (rule?.custom) row('repeat', 'Repeat', 'Repeats (custom rule)');
    else if (rule?.rule) row('repeat', 'Repeat', describeRule(rule.rule));

    if (draft.location) row('mapPin', 'Location', ...linkify(draft.location));

    if (calendar) {
      const name = calendar.icon
        ? `${calendar.icon} ${calendar.displayName}`
        : calendar.displayName;
      row('calendar', 'Calendar', name);
    }

    // Blank lines around and inside the text are only dropped here, not in the calendar file.
    const description = tidyDescription(draft.description);
    if (description) {
      row('notes', 'Description', ...linkify(description)).classList.add('event-view-description');
    }

    const note = document.createElement('p');
    note.className = 'readonly-note';
    note.textContent = options.note ?? '';
    note.hidden = !options.note;

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    if (options.canDuplicate) {
      const duplicate = document.createElement('button');
      duplicate.type = 'button';
      duplicate.className = 'btn';
      duplicate.textContent = 'Duplicate';
      duplicate.addEventListener('click', () => close('duplicate'));
      actions.append(duplicate);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => close(null));
    actions.append(closeBtn);

    dialog.append(header, details, note, actions);

    // E switches to editing, like the pen.
    dialog.addEventListener('keydown', (e) => {
      if (options.canEdit && e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        close('edit');
      }
    });
    // A click on the backdrop (outside the dialog box) closes it.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        const box = dialog.getBoundingClientRect();
        const inside =
          e.clientX >= box.left &&
          e.clientX <= box.right &&
          e.clientY >= box.top &&
          e.clientY <= box.bottom;
        if (!inside) close(null);
      }
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    closeBtn.focus();
  });
}
