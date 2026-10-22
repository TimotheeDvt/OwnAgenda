import { describe, expect, it } from 'vitest';
import {
  apcaContrast,
  DARK_TEXT,
  LIGHT_TEXT,
  parseHexColor,
  readableTextColor,
} from '../src/util/color';

describe('readableTextColor', () => {
  it('parses short and long hex colors', () => {
    expect(parseHexColor('#3b82f6')).toEqual([59, 130, 246]);
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
    expect(parseHexColor('red')).toBeNull();
  });

  it('computes APCA contrast like the reference (black/white extremes)', () => {
    expect(apcaContrast('#000000', '#ffffff')).toBeCloseTo(106.0, 0);
    expect(apcaContrast('#ffffff', '#000000')).toBeCloseTo(-107.9, 0);
  });

  it('uses white text on red, blue and other saturated mid-tones', () => {
    for (const bg of ['#ef4444', '#dc2626', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316']) {
      expect(readableTextColor(bg), bg).toBe(LIGHT_TEXT);
    }
  });

  it('uses white text on dark backgrounds', () => {
    for (const bg of ['#000000', '#1e3a8a', '#334155', '#64748b']) {
      expect(readableTextColor(bg), bg).toBe(LIGHT_TEXT);
    }
  });

  it('uses dark text on light backgrounds', () => {
    for (const bg of ['#ffffff', '#fde047', '#f59e0b', '#a7f3d0', '#22c55e']) {
      expect(readableTextColor(bg), bg).toBe(DARK_TEXT);
    }
  });

  it('falls back to white for unknown colors', () => {
    expect(readableTextColor('not-a-color')).toBe(LIGHT_TEXT);
  });
});
