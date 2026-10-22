export interface PromptField {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  type?: 'text' | 'url';
  /** Allow submitting the form with this field empty. */
  optional?: boolean;
}

export interface FormPromptOptions {
  title: string;
  /** Explanation shown above the fields; may contain trusted HTML. */
  descriptionHtml?: string;
  fields: PromptField[];
  submitLabel?: string;
}

/**
 * Modal with one or more text fields. Resolves with the trimmed values by field name, or null if
 * cancelled. Required fields must be non-empty to submit.
 */
export function promptForm(options: FormPromptOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'folder-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';

    const heading = document.createElement('h2');
    heading.textContent = options.title;
    form.appendChild(heading);
    if (options.descriptionHtml) {
      const description = document.createElement('p');
      description.innerHTML = options.descriptionHtml;
      form.appendChild(description);
    }

    const inputs = options.fields.map((field) => {
      const label = document.createElement('label');
      label.className = 'prompt-field';
      label.textContent = field.label;
      const input = document.createElement('input');
      input.name = field.name;
      input.type = field.type ?? 'text';
      input.autocomplete = 'off';
      input.required = !field.optional;
      input.value = field.value ?? '';
      input.placeholder = field.placeholder ?? '';
      label.appendChild(input);
      form.appendChild(label);
      return input;
    });

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary';
    submit.textContent = options.submitLabel ?? 'Save';
    actions.append(cancel, submit);
    form.appendChild(actions);
    dialog.appendChild(form);

    let result: Record<string, string> | null = null;
    form.addEventListener('submit', () => {
      result = Object.fromEntries(inputs.map((i) => [i.name, i.value.trim()]));
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    inputs[0]?.select();
  });
}

export interface TextPromptOptions {
  title: string;
  descriptionHtml?: string;
  label: string;
  value?: string;
  placeholder?: string;
  submitLabel?: string;
}

/** Modal with one text field. Resolves with the trimmed value, or null if cancelled or empty. */
export async function promptText(options: TextPromptOptions): Promise<string | null> {
  const values = await promptForm({
    title: options.title,
    descriptionHtml: options.descriptionHtml,
    submitLabel: options.submitLabel,
    fields: [
      {
        name: 'value',
        label: options.label,
        value: options.value,
        placeholder: options.placeholder,
      },
    ],
  });
  return values?.value || null;
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
