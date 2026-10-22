export interface TextPromptOptions {
  title: string;
  /** Explanation shown above the field; may contain trusted HTML. */
  descriptionHtml?: string;
  label: string;
  value?: string;
  placeholder?: string;
  submitLabel?: string;
}

/** Modal with one text field. Resolves with the trimmed value, or null if cancelled or empty. */
export function promptText(options: TextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'folder-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2></h2>
        <p class="prompt-description"></p>
        <label>
          <span class="prompt-label"></span>
          <input name="value" type="text" required autocomplete="off" />
        </label>
        <div class="dialog-actions">
          <button type="button" value="cancel" class="btn">Cancel</button>
          <button type="submit" value="save" class="btn btn-primary"></button>
        </div>
      </form>`;

    dialog.querySelector('h2')!.textContent = options.title;
    const description = dialog.querySelector<HTMLElement>('.prompt-description')!;
    if (options.descriptionHtml) description.innerHTML = options.descriptionHtml;
    else description.remove();
    dialog.querySelector('.prompt-label')!.textContent = options.label;
    const input = dialog.querySelector<HTMLInputElement>('input[name="value"]')!;
    input.value = options.value ?? '';
    input.placeholder = options.placeholder ?? '';
    dialog.querySelector('button[type="submit"]')!.textContent = options.submitLabel ?? 'Save';

    let result: string | null = null;
    dialog.querySelector('form')!.addEventListener('submit', () => {
      result = input.value.trim() || null;
    });
    dialog.querySelector('button[value="cancel"]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    input.select();
  });
}

/** Asks for the Drive folder path that holds the .ics files. */
export async function promptFolderPath(current: string, firstRun = false): Promise<string | null> {
  const value = await promptText({
    title: firstRun ? 'Where are your calendars?' : 'Change folder',
    descriptionHtml:
      'Path of the Google Drive folder that contains your <code>.ics</code> files, starting ' +
      'from My Drive. Use <code>/</code> between folders.',
    label: 'Folder path',
    value: current,
    placeholder: 'Agendas/ics',
  });
  return value?.replace(/^\/+|\/+$/g, '') || null;
}
