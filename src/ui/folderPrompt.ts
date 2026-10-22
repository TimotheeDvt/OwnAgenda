/**
 * Modal asking for the Drive folder path that holds the .ics files.
 * Resolves with the trimmed path, or null if the user cancels.
 */
export function promptFolderPath(current: string, firstRun = false): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'folder-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2></h2>
        <p>
          Path of the Google Drive folder that contains your <code>.ics</code> files,
          starting from My Drive. Use <code>/</code> between folders.
        </p>
        <label>
          Folder path
          <input name="path" type="text" required placeholder="Agendas/ics" autocomplete="off" />
        </label>
        <div class="dialog-actions">
          <button type="button" value="cancel" class="btn">Cancel</button>
          <button type="submit" value="save" class="btn btn-primary">Save</button>
        </div>
      </form>`;

    const heading = dialog.querySelector('h2')!;
    heading.textContent = firstRun ? 'Where are your calendars?' : 'Change folder';
    const input = dialog.querySelector<HTMLInputElement>('input[name="path"]')!;
    input.value = current;
    const cancel = dialog.querySelector<HTMLButtonElement>('button[value="cancel"]')!;

    let result: string | null = null;
    dialog.querySelector('form')!.addEventListener('submit', () => {
      result = input.value.trim().replace(/^\/+|\/+$/g, '') || null;
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    input.select();
  });
}
