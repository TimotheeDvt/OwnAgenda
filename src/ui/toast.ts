export type ToastKind = 'info' | 'success' | 'warning' | 'error';

let container: HTMLElement | null = null;

function getContainer(): HTMLElement {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toasts';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string, kind: ToastKind = 'info', timeoutMs = 5000): void {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => toast.remove());
  toast.appendChild(close);

  getContainer().appendChild(toast);
  if (kind !== 'error') setTimeout(() => toast.remove(), timeoutMs);
}
