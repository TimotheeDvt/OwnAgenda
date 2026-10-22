export interface Choice<T extends string> {
  value: T;
  label: string;
  kind?: 'primary' | 'danger';
}

/**
 * Modal with a message and a set of buttons. Resolves with the chosen value, or null if the
 * dialog is dismissed with Escape.
 */
export function chooseOption<T extends string>(
  title: string,
  message: string,
  choices: Choice<T>[],
): Promise<T | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'folder-dialog';

    const heading = document.createElement('h2');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';

    let result: T | null = null;
    for (const choice of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn${choice.kind === 'primary' ? ' btn-primary' : ''}${
        choice.kind === 'danger' ? ' btn-danger-solid' : ''
      }`;
      btn.textContent = choice.label;
      btn.addEventListener('click', () => {
        result = choice.value;
        dialog.close();
      });
      actions.appendChild(btn);
    }

    dialog.append(heading, text, actions);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
