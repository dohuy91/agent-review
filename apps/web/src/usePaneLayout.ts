import { useLayoutEffect, useState, type RefObject } from "react";
import {
  defaultPaneWidths,
  fitPaneWidths,
  getPaneBounds,
  isDesktopPaneLayout,
  paneSeparatorWidth,
  sanitizePaneWidths,
  type PaneSide,
  type PaneWidths,
} from "./paneLayout.js";

/** Remember user widths separately from widths temporarily fitted to the window. */
export function usePaneLayout(
  workspace: RefObject<HTMLElement | null>,
  initialWidths: PaneWidths = defaultPaneWidths,
) {
  const [preferredWidths, setPreferredWidths] = useState(() =>
    sanitizePaneWidths(initialWidths),
  );
  const [size, setSize] = useState(() => ({
    viewport: window.innerWidth,
    workspace: window.innerWidth,
  }));

  useLayoutEffect(() => {
    function measure() {
      const measured = workspace.current?.getBoundingClientRect().width;
      const next = {
        viewport: window.innerWidth,
        workspace:
          measured && Number.isFinite(measured) ? measured : window.innerWidth,
      };
      setSize((previous) =>
        previous.viewport === next.viewport &&
        previous.workspace === next.workspace
          ? previous
          : next,
      );
    }
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (workspace.current) observer?.observe(workspace.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [workspace]);

  const desktop = isDesktopPaneLayout(size.viewport);
  const widths = fitPaneWidths(preferredWidths, size.workspace);
  const bounds = {
    left: getPaneBounds("left", widths, size.workspace),
    right: getPaneBounds("right", widths, size.workspace),
  };

  function resizePane(side: PaneSide, value: number) {
    if (!desktop || !Number.isFinite(value)) return;
    setPreferredWidths((previous) => {
      const { min, max } = getPaneBounds(
        side,
        fitPaneWidths(previous, size.workspace),
        size.workspace,
      );
      const width = Math.max(min, Math.min(max, Math.round(value)));
      return previous[side] === width
        ? previous
        : { ...previous, [side]: width };
    });
  }

  function resetPane(side: PaneSide) {
    if (!desktop) return;
    setPreferredWidths((previous) =>
      previous[side] === defaultPaneWidths[side]
        ? previous
        : { ...previous, [side]: defaultPaneWidths[side] },
    );
  }

  return {
    desktop,
    widths,
    preferredWidths,
    bounds,
    resizePane,
    resetPane,
    gridTemplateColumns: desktop
      ? `${widths.left}px ${paneSeparatorWidth}px minmax(0, 1fr) ${paneSeparatorWidth}px ${widths.right}px`
      : "minmax(0, 1fr)",
  };
}
