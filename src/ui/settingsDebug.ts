import { getSettings } from '../store/settingsStore';
import { showToast } from './toast';

/** Dev-only dialog showing the settings as they are saved (settings.json), with a Copy button. */
export function showSettingsDebug(): void {
  if (document.querySelector('dialog.settings-debug')) return;
  const json = JSON.stringify(getSettings(), null, 2);

  const dialog = document.createElement('dialog');
  dialog.className = 'folder-dialog settings-debug';
  const heading = document.createElement('h2');
  heading.textContent = 'settings.json';
  const pre = document.createElement('pre');
  pre.className = 'settings-debug-json';
  pre.textContent = json;

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(json).then(
      () => showToast('Settings copied.'),
      () => showToast('Could not copy the settings.', 'error'),
    );
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-primary';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  actions.append(copy, close);

  dialog.append(heading, pre, actions);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
  close.focus();
}
