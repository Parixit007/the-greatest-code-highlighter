// src/core/colors.ts
//
// The single place highlight colors are defined. Key order is the order used
// by the color picker and by the cycle shortcut.

import { HighlightColor } from './types';

interface ColorStyle {
  label: string;       // shown in the color picker
  background: string;  // highlight background in the editor
  ruler: string;       // marker in the scrollbar overview ruler
}

export const COLOR_STYLES: Record<HighlightColor, ColorStyle> = {
  red:    { label: '🔴  Red',    background: 'rgba(255, 99, 99, 0.25)',  ruler: 'rgba(255, 99, 99, 0.8)' },
  blue:   { label: '🔵  Blue',   background: 'rgba(99, 149, 255, 0.25)', ruler: 'rgba(99, 149, 255, 0.8)' },
  green:  { label: '🟢  Green',  background: 'rgba(99, 255, 132, 0.25)', ruler: 'rgba(99, 255, 132, 0.8)' },
  pink:   { label: '🩷  Pink',   background: 'rgba(255, 99, 220, 0.25)', ruler: 'rgba(255, 99, 220, 0.8)' },
  cyan:   { label: '🩵  Cyan',   background: 'rgba(99, 229, 255, 0.25)', ruler: 'rgba(99, 229, 255, 0.8)' },
  yellow: { label: '🟡  Yellow', background: 'rgba(255, 220, 50, 0.25)', ruler: 'rgba(255, 220, 50, 0.8)' },
};

export const COLORS = Object.keys(COLOR_STYLES) as HighlightColor[];

export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COLOR_STYLES, value);
}
