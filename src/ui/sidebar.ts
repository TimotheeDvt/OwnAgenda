import { getCalendarState, onCalendarsChange, type CalendarState } from '../store/calendarStore';
import {
  getCalendarSettings,
  getSettings,
  onSettingsChange,
  updateCalendarSettings,
} from '../store/settingsStore';

export interface SidebarActions {
  onChangeFolder(): void;
  onReload(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFolder(actions: SidebarActions, state: CalendarState): HTMLElement {
  const section = el('section', 'sidebar-section');
  section.appendChild(el('h2', 'sidebar-title', 'Folder'));
  const path = getSettings().folderPath;
  section.appendChild(el('div', 'folder-path', path || 'Not set'));

  const buttons = el('div', 'sidebar-buttons');
  const change = el('button', 'btn btn-small', path ? 'Change' : 'Set folder');
  change.type = 'button';
  change.addEventListener('click', actions.onChangeFolder);
  buttons.appendChild(change);
  if (path) {
    const reload = el('button', 'btn btn-small', 'Reload');
    reload.type = 'button';
    reload.disabled = state.status === 'loading';
    reload.addEventListener('click', actions.onReload);
    buttons.appendChild(reload);
  }
  section.appendChild(buttons);
  return section;
}

function renderCalendars(state: CalendarState): HTMLElement {
  const section = el('section', 'sidebar-section');
  section.appendChild(el('h2', 'sidebar-title', 'Calendars'));

  if (state.status === 'loading') section.appendChild(el('p', 'muted', 'Loading…'));
  if (state.error) section.appendChild(el('p', 'sidebar-error', state.error));

  const list = el('ul', 'calendar-list');
  state.calendars.forEach((calendar, index) => {
    const settings = getCalendarSettings(calendar.fileId, index);
    const item = el('li', 'calendar-item');

    const visible = el('input');
    visible.type = 'checkbox';
    visible.checked = settings.visible;
    visible.setAttribute('aria-label', `Show ${calendar.displayName}`);
    visible.addEventListener('change', () =>
      updateCalendarSettings(calendar.fileId, index, { visible: visible.checked }),
    );

    const color = el('input', 'calendar-color');
    color.type = 'color';
    color.value = settings.color;
    color.setAttribute('aria-label', `Color of ${calendar.displayName}`);
    color.addEventListener('change', () =>
      updateCalendarSettings(calendar.fileId, index, { color: color.value }),
    );

    const name = el('span', 'calendar-name', calendar.displayName);
    name.title = calendar.name;

    const label = el('label', 'calendar-label');
    label.append(visible, name);
    item.append(color, label);
    list.appendChild(item);
  });
  section.appendChild(list);

  if (state.warnings.length) {
    const warnings = el('ul', 'sidebar-warnings');
    for (const warning of state.warnings) warnings.appendChild(el('li', undefined, warning));
    section.appendChild(warnings);
  }
  return section;
}

export function mountSidebar(host: HTMLElement, actions: SidebarActions): () => void {
  const render = () => {
    const state = getCalendarState();
    host.replaceChildren(renderFolder(actions, state), renderCalendars(state));
  };
  render();
  const offCalendars = onCalendarsChange(render);
  const offSettings = onSettingsChange(render);
  return () => {
    offCalendars();
    offSettings();
    host.replaceChildren();
  };
}
