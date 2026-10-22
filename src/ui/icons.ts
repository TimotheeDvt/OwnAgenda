// Small line icons (24×24, stroke = currentColor) so they follow the theme's text color.

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  folder: svg(
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  sun: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41' +
      'M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  ),
  moon: svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  logout: svg(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/>' +
      '<path d="M21 12H9"/>',
  ),
  keyboard: svg(
    '<rect x="2" y="6" width="20" height="12" rx="2"/>' +
      '<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  ),
  globe: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/>' +
      '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  ),
  // Solid dots (fill, no stroke) so they stay visible at small sizes.
  grip: svg(
    '<g fill="currentColor" stroke="none">' +
      '<circle cx="8.5" cy="5" r="3"/><circle cx="15.5" cy="5" r="3"/>' +
      '<circle cx="8.5" cy="12" r="3"/><circle cx="15.5" cy="12" r="3"/>' +
      '<circle cx="8.5" cy="19" r="3"/><circle cx="15.5" cy="19" r="3"/></g>',
  ),
  link: svg(
    '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/>' +
      '<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
  ),
} as const;

export type IconName = keyof typeof ICONS;
