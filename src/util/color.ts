/** Text colors used on top of event backgrounds. */
export const DARK_TEXT = '#111827';
export const LIGHT_TEXT = '#ffffff';

/** "#3b82f6" or "#38f" → [r, g, b] in 0–255, or null if not a hex color. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const digits = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

/** Screen luminance as APCA computes it, with its soft clamp for near-black colors. */
function apcaLuminance([r, g, b]: [number, number, number]): number {
  const y =
    0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

/**
 * APCA lightness contrast (Lc, roughly 0–106) of text on a background; the sign only tells the
 * polarity, so callers compare absolute values. APCA (the contrast method being developed for
 * WCAG 3) matches perception better than the WCAG 2 ratio, which overrates dark text on
 * saturated mid-tones such as red or blue.
 */
export function apcaContrast(text: string, background: string): number {
  const t = parseHexColor(text);
  const b = parseHexColor(background);
  if (!t || !b) return 0;
  const yText = apcaLuminance(t);
  const yBg = apcaLuminance(b);
  if (yBg > yText) {
    // Dark text on a light background.
    const s = (yBg ** 0.56 - yText ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  // Light text on a dark background.
  const s = (yBg ** 0.65 - yText ** 0.62) * 1.14;
  return s > -0.1 ? 0 : (s + 0.027) * 100;
}

/**
 * The text color (dark or white) that reads best on the given background, so event titles stay
 * legible whatever color a calendar has. On a tie, white wins.
 */
export function readableTextColor(background: string): string {
  if (!parseHexColor(background)) return LIGHT_TEXT;
  const dark = Math.abs(apcaContrast(DARK_TEXT, background));
  const light = Math.abs(apcaContrast(LIGHT_TEXT, background));
  return dark > light ? DARK_TEXT : LIGHT_TEXT;
}
