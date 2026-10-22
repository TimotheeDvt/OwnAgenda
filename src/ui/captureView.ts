import { toBlob } from 'html-to-image';
import { showToast } from './toast';

/**
 * Copies an element (the calendar view) to the clipboard as a PNG, like a screenshot of it. If
 * the browser can't put images on the clipboard, the PNG is downloaded instead.
 *
 * Must be called from a click: browsers only allow clipboard writes during a user gesture
 * (the ClipboardItem is created right away, with the image still being rendered).
 */
export function captureToClipboard(
  element: HTMLElement,
  options: { fileName?: string; exclude?: (node: HTMLElement) => boolean } = {},
): void {
  const fileName = options.fileName ?? 'calendar.png';
  const png = renderToPng(element, options.exclude);

  const download = async () => {
    const url = URL.createObjectURL(await png);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Image downloaded (this browser can't copy images to the clipboard).");
  };

  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
  if (!canCopy) {
    download().catch((err: unknown) => showToast(captureError(err), 'error'));
    return;
  }
  navigator.clipboard
    .write([new ClipboardItem({ 'image/png': png })])
    .then(() => showToast('Calendar view copied. Paste it anywhere.', 'success'))
    .catch(async (err: unknown) => {
      // Clipboard refused (permissions, unfocused page...): fall back to a download.
      try {
        await download();
      } catch {
        showToast(captureError(err), 'error');
      }
    });
}

/** Renders the element as it looks on screen (scroll positions included) to a PNG. */
export function renderToPng(
  element: HTMLElement,
  exclude?: (node: HTMLElement) => boolean,
): Promise<Blob> {
  const restoreScroll = freezeScrollPositions(element);
  return toBlob(element, {
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    // Leave out elements that aren't part of the view (e.g. the camera button itself).
    filter: (node) => !(node instanceof HTMLElement && exclude?.(node)),
  })
    .then((blob) => {
      if (!blob) throw new Error('The view could not be rendered.');
      return blob;
    })
    .finally(restoreScroll);
}

/**
 * The image is drawn from a copy of the page, and copies lose scroll positions (a scrolled week
 * view would come out at 00:00). So while capturing, each scrolled area is reset to the top and
 * its content shifted by the same amount: it looks identical on screen, and the copy keeps it.
 * Returns the function that puts everything back.
 */
function freezeScrollPositions(root: HTMLElement): () => void {
  const changes: { el: HTMLElement; top: number; left: number; transforms: string[] }[] = [];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    if (!el.scrollTop && !el.scrollLeft) continue;
    const children = [...el.children] as HTMLElement[];
    changes.push({
      el,
      top: el.scrollTop,
      left: el.scrollLeft,
      transforms: children.map((c) => c.style.transform),
    });
    const shift = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
    for (const child of children) child.style.transform = `${shift} ${child.style.transform}`;
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
  return () => {
    for (const { el, top, left, transforms } of changes) {
      [...el.children].forEach(
        (c, i) => ((c as HTMLElement).style.transform = transforms[i] ?? ''),
      );
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  };
}

function captureError(err: unknown): string {
  return `Could not capture the view: ${err instanceof Error ? err.message : String(err)}`;
}
