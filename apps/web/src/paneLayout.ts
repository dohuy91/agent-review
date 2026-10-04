export type PaneSide = "left" | "right";
export interface PaneWidths {
  left: number;
  right: number;
}
export interface PaneBounds {
  min: number;
  max: number;
}

export const defaultPaneWidths: PaneWidths = { left: 350, right: 350 };
export const paneWidthLimits: Record<PaneSide, PaneBounds> = {
  left: { min: 160, max: 420 },
  right: { min: 220, max: 520 },
};
export const paneRailBreakpoint = 900;
export const paneMinimumCenterWidth = 280;
export const paneSeparatorWidth = 5;

export function sanitizePaneWidths(value: unknown): PaneWidths {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const widths = { ...defaultPaneWidths };
  for (const side of ["left", "right"] as const) {
    const width = raw[side];
    if (typeof width === "number" && Number.isFinite(width)) {
      const { min, max } = paneWidthLimits[side];
      widths[side] = Math.max(min, Math.min(max, Math.round(width)));
    }
  }
  return widths;
}

export function isDesktopPaneLayout(viewportWidth: number) {
  return viewportWidth > paneRailBreakpoint;
}

export function fitPaneWidths(
  value: PaneWidths,
  workspaceWidth: number,
): PaneWidths {
  const widths = sanitizePaneWidths(value);
  const available = Math.max(
    paneWidthLimits.left.min + paneWidthLimits.right.min,
    workspaceWidth - paneMinimumCenterWidth - 2 * paneSeparatorWidth,
  );
  // Keep the navigation pane stable while reclaiming the details pane first.
  widths.right = Math.max(
    paneWidthLimits.right.min,
    Math.min(widths.right, available - widths.left),
  );
  widths.left = Math.max(
    paneWidthLimits.left.min,
    Math.min(widths.left, available - widths.right),
  );
  return widths;
}

export function getPaneBounds(
  side: PaneSide,
  widths: PaneWidths,
  workspaceWidth: number,
): PaneBounds {
  const opposite = side === "left" ? "right" : "left";
  const { min, max } = paneWidthLimits[side];
  return {
    min,
    max: Math.max(
      min,
      Math.min(
        max,
        workspaceWidth -
          paneMinimumCenterWidth -
          2 * paneSeparatorWidth -
          widths[opposite],
      ),
    ),
  };
}

export function resizePaneWidths(
  widths: PaneWidths,
  side: PaneSide,
  value: number,
  workspaceWidth: number,
): PaneWidths {
  const fitted = fitPaneWidths(widths, workspaceWidth);
  const { min, max } = getPaneBounds(side, fitted, workspaceWidth);
  return {
    ...fitted,
    [side]: Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fitted[side],
  };
}
