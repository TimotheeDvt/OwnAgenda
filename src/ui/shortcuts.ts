import type { ViewName } from '../store/settingsStore';

export interface ShortcutActions {
  today(): void;
  prev(): void;
  next(): void;
  changeView(view: ViewName): void;
  newEvent(): void;
  focusSearch(): void;
  reloadAll(): void;
  undo(): void;
  redo(): void;
}

export const SHORTCUTS: [keys: string, description: string][] = [
  ['T', 'Go to today'],
  ['← / P', 'Previous period'],
  ['→ / N', 'Next period'],
  ['M', 'Month view'],
  ['W', 'Week view'],
  ['D', 'Day view'],
  ['L', 'List view'],
  ['C', 'New event'],
  ['/', 'Search events'],
  ['Ctrl + Z', 'Undo the last change'],
  ['Ctrl + Y / Ctrl + Shift + Z', 'Redo'],
  ['Shift + R', 'Reload all calendars from Drive'],
  ['?', 'Show this help'],
  ['Esc', 'Close a dialog'],
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function showShortcutsHelp(): void {
  if (document.querySelector('dialog.shortcuts-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'folder-dialog shortcuts-dialog';
  const heading = document.createElement('h2');
  heading.textContent = 'Keyboard shortcuts';
  const table = document.createElement('dl');
  table.className = 'shortcut-list';
  for (const [keys, description] of SHORTCUTS) {
    const dt = document.createElement('dt');
    for (const key of keys.split(' / ')) {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      dt.appendChild(kbd);
    }
    const dd = document.createElement('dd');
    dd.textContent = description;
    table.append(dt, dd);
  }
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-primary';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  actions.appendChild(close);
  dialog.append(heading, table, actions);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

/** Installs global keyboard shortcuts. Returns a function that removes them. */
export function installShortcuts(actions: ShortcutActions): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.defaultPrevented) return;
    // In a text field, Ctrl+Z undoes the typing instead.
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      const action =
        key === 'z'
          ? e.shiftKey
            ? actions.redo
            : actions.undo
          : key === 'y'
            ? actions.redo
            : null;
      if (!action) return;
      e.preventDefault();
      action();
      return;
    }

    const handlers: Record<string, () => void> = {
      t: actions.today,
      ArrowLeft: actions.prev,
      p: actions.prev,
      ArrowRight: actions.next,
      n: actions.next,
      m: () => actions.changeView('dayGridMonth'),
      w: () => actions.changeView('timeGridWeek'),
      d: () => actions.changeView('timeGridDay'),
      l: () => actions.changeView('listWeek'),
      c: actions.newEvent,
      '/': actions.focusSearch,
      R: actions.reloadAll,
      '?': showShortcutsHelp,
    };
    // Shift is only meaningful for "R" (reload) and "?".
    const key = e.shiftKey && e.key !== 'R' && e.key !== '?' ? '' : e.key;
    const handler = handlers[key];
    if (!handler) return;
    e.preventDefault();
    handler();
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
