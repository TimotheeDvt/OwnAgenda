// Calendar icons use the Material Design Icons font — the same icons as Nerd Fonts' "nf-md-*"
// set, at the same codepoints (U+F0001…), so an icon copied from the Nerd Fonts cheat sheet
// shows correctly. Emoji keep working as before (they come from the system's emoji font).
import fontUrl from '@mdi/font/fonts/materialdesignicons-webfont.woff2?url';

export const ICON_FONT_FAMILY = 'Agenda Icons';

/**
 * Registers the icon font for the icon codepoints only. Thanks to the unicode-range, the browser
 * downloads it only when an icon is actually on screen, and normal text never uses it. It is
 * first in the page's font stack (see main.css), so icons render anywhere text does.
 *
 * Declared as a stylesheet @font-face (not the FontFace API) so that "capture view" can find and
 * embed it in the image.
 */
export function registerIconFont(): void {
  const style = document.createElement('style');
  style.dataset.iconFont = '';
  style.textContent =
    `@font-face { font-family: '${ICON_FONT_FAMILY}'; ` +
    `src: url('${fontUrl}') format('woff2'); ` +
    `unicode-range: U+F0000-FFFFD; font-display: block; }`;
  document.head.appendChild(style);
}

/** Material Design icon → character (as stored in settings). */
const mdi = (codepoint: number) => String.fromCodePoint(codepoint);

/** Default icons offered for calendars: [character, name]. */
export const DEFAULT_CALENDAR_ICONS: [icon: string, name: string][] = [
  [mdi(0xf00ed), 'calendar'],
  [mdi(0xf00d6), 'briefcase'],
  [mdi(0xf02dc), 'home'],
  [mdi(0xf0474), 'school'],
  [mdi(0xf14f7), 'book'],
  [mdi(0xf0322), 'laptop'],
  [mdi(0xf01e6), 'dumbbell'],
  [mdi(0xf070e), 'run'],
  [mdi(0xf04b8), 'soccer'],
  [mdi(0xf075a), 'music'],
  [mdi(0xf1056), 'party'],
  [mdi(0xf00eb), 'cake'],
  [mdi(0xf02d1), 'heart'],
  [mdi(0xf0849), 'people'],
  [mdi(0xf0e7d), 'baby'],
  [mdi(0xf0a43), 'dog'],
  [mdi(0xf0a70), 'restaurant'],
  [mdi(0xf0176), 'coffee'],
  [mdi(0xf0110), 'shopping'],
  [mdi(0xf001d), 'travel'],
  [mdi(0xf010b), 'car'],
  [mdi(0xf0092), 'beach'],
  [mdi(0xf02e0), 'hospital'],
  [mdi(0xf0402), 'medicine'],
  [mdi(0xf117b), 'meditation'],
  [mdi(0xf0297), 'games'],
  [mdi(0xf03d8), 'art'],
  [mdi(0xf0fce), 'movies'],
  [mdi(0xf0100), 'photo'],
  [mdi(0xf0e66), 'garden'],
  [mdi(0xf0335), 'idea'],
  [mdi(0xf05b7), 'repairs'],
  [mdi(0xf0114), 'money'],
  [mdi(0xf0403), 'pin'],
  [mdi(0xf04ce), 'star'],
  [mdi(0xf009a), 'reminder'],
  [mdi(0xf0579), 'faith'],
  [mdi(0xf0a1f), 'vote'],
  [mdi(0xf0070), 'bank'],
  [mdi(0xf01e7), 'world'],
];
