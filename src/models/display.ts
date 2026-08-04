export const POPUP_HEIGHT = 480;

export const POPUP_WIDTHS = {
  narrow: 300,
  default: 360,
  wide: 440,
} as const;

export type PopupWidthPreset = keyof typeof POPUP_WIDTHS;
export type PopupWidth = typeof POPUP_WIDTHS[PopupWidthPreset];

export function isPopupWidth(value: unknown): value is PopupWidth {
  return Object.values(POPUP_WIDTHS).includes(value as PopupWidth);
}

export function resolvePopupWidth(
  value: unknown,
  legacyZoom?: unknown
): PopupWidth {
  const width = Number(value);
  if (isPopupWidth(width)) {
    return width;
  }

  const zoom = Number(legacyZoom);
  if (Number.isFinite(zoom) && zoom > 0 && zoom < 100) {
    return POPUP_WIDTHS.narrow;
  }
  if (Number.isFinite(zoom) && zoom > 100) {
    return POPUP_WIDTHS.wide;
  }
  return POPUP_WIDTHS.default;
}
