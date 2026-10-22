import { getCalendarState, onCalendarsChange, type CalendarState } from '../store/calendarStore';
import {
  getCalendarSettings,
  getSettings,
  onSettingsChange,
  updateCalendarSettings,
} from '../store/settingsStore';
import type { AgendaEvent } from '../types';
import { mountSearch } from './search';

export interface SidebarActions {
  onChangeFolder(): void;
  onReload(): void;
  onRefreshCalendar(fileId: string): void;
  onRenameCalendar(fileId: string): void;
  onNewCalendar(): void;
  onPickSearchResult(event: AgendaEvent): void;
  onToggleOfflineCache(enabled: boolean): void;
  onShowShortcuts(): void;
}

export interface Sidebar {
  focusSearch(): void;
  destroy(): void;
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

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', className, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = button(icon, 'icon-btn', onClick);
  btn.setAttribute('aria-label', label);
  btn.title = label;
  return btn;
}

function renderFolder(actions: SidebarActions, state: CalendarState): HTMLElement[] {
  const path = getSettings().folderPath;
  const buttons = el('div', 'sidebar-buttons');
  buttons.appendChild(
    button(path ? 'Change' : 'Set folder', 'btn btn-small', actions.onChangeFolder),
  );
  if (path) {
    const reload = button('Reload all', 'btn btn-small', actions.onReload);
    reload.disabled = state.status === 'loading';
    reload.title = 'Download every calendar of the folder again from Google Drive';
    buttons.appendChild(reload);
  }
  return [
    el('h2', 'sidebar-title', 'Folder'),
    el('div', 'folder-path', path || 'Not set'),
    buttons,
  ];
}

function renderCalendars(actions: SidebarActions, state: CalendarState): HTMLElement[] {
  const nodes: HTMLElement[] = [el('h2', 'sidebar-title', 'Calendars')];

  if (state.status === 'loading') {
    nodes.push(
      el('p', 'muted', state.calendars.length ? 'Updating from Google Drive…' : 'Loading…'),
    );
  }
  if (state.error) nodes.push(el('p', 'sidebar-error', state.error));

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
    name.title = `${calendar.name}${calendar.dirty ? ' (unsaved changes)' : ''}`;
    if (calendar.dirty) name.classList.add('is-dirty');

    const label = el('label', 'calendar-label');
    label.append(visible, name);

    const refreshing = state.refreshing.includes(calendar.fileId);
    const refresh = iconButton('↻', `Refresh ${calendar.displayName} from Google Drive`, () =>
      actions.onRefreshCalendar(calendar.fileId),
    );
    refresh.disabled = refreshing || state.status === 'loading' || state.fromCache;
    if (refreshing) refresh.classList.add('is-spinning');
    const rename = iconButton('✎', `Rename ${calendar.displayName}`, () =>
      actions.onRenameCalendar(calendar.fileId),
    );

    const tools = el('span', 'calendar-tools');
    tools.append(rename, refresh);
    item.append(color, label, tools);
    list.appendChild(item);
  });
  nodes.push(list);

  if (state.folderId) {
    nodes.push(button('+ New calendar', 'btn btn-small new-calendar', actions.onNewCalendar));
  }

  if (state.warnings.length) {
    const warnings = el('ul', 'sidebar-warnings');
    for (const warning of state.warnings) warnings.appendChild(el('li', undefined, warning));
    nodes.push(warnings);
  }
  return nodes;
}

function renderOptions(actions: SidebarActions): HTMLElement[] {
  const offline = el('input');
  offline.type = 'checkbox';
  offline.checked = getSettings().offlineCache;
  offline.addEventListener('change', () => actions.onToggleOfflineCache(offline.checked));
  const offlineLabel = el('label', 'option-label');
  offlineLabel.append(offline, el('span', undefined, 'Keep an offline copy on this device'));
  offlineLabel.title =
    'Stores your calendars in this browser so the agenda opens instantly and stays readable ' +
    'when Google Drive is unreachable.';

  return [
    el('h2', 'sidebar-title', 'Options'),
    offlineLabel,
    button('Keyboard shortcuts  ( ? )', 'link-btn', actions.onShowShortcuts),
  ];
}

export function mountSidebar(host: HTMLElement, actions: SidebarActions): Sidebar {
  const searchSection = el('section', 'sidebar-section search-section');
  const folderSection = el('section', 'sidebar-section');
  const calendarsSection = el('section', 'sidebar-section');
  const optionsSection = el('section', 'sidebar-section');
  host.replaceChildren(searchSection, folderSection, calendarsSection, optionsSection);

  // The search box is mounted once so typing isn't interrupted by re-renders.
  const search = mountSearch(searchSection, actions.onPickSearchResult);

  const render = () => {
    const state = getCalendarState();
    folderSection.replaceChildren(...renderFolder(actions, state));
    calendarsSection.replaceChildren(...renderCalendars(actions, state));
    optionsSection.replaceChildren(...renderOptions(actions));
  };
  render();
  const offCalendars = onCalendarsChange(render);
  const offSettings = onSettingsChange(render);

  return {
    focusSearch: () => search.focus(),
    destroy: () => {
      offCalendars();
      offSettings();
      search.destroy();
      host.replaceChildren();
    },
  };
}
