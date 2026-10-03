import { expect, test } from "vitest";
import {
  fitPaneWidths,
  getPaneBounds,
  isDesktopPaneLayout,
  paneMinimumCenterWidth,
  paneSeparatorWidth,
  resizePaneWidths,
} from "../apps/web/src/paneLayout.js";

test("bounded widths leave the central diff usable and account for both separators", () => {
  const widths = fitPaneWidths({ left: 420, right: 520 }, 901);
  expect(widths.left).toBeGreaterThanOrEqual(160);
  expect(widths.right).toBeGreaterThanOrEqual(220);
  expect(
    901 - widths.left - widths.right - 2 * paneSeparatorWidth,
  ).toBeGreaterThanOrEqual(paneMinimumCenterWidth);
  expect(fitPaneWidths({ left: 205, right: 270 }, 1400)).toEqual({
    left: 205,
    right: 270,
  });
});

test("resizing one pane preserves the opposite pane and respects its remaining space", () => {
  const widths = fitPaneWidths({ left: 205, right: 420 }, 1000);
  const bounds = getPaneBounds("left", widths, 1000);
  expect(bounds).toEqual({ min: 160, max: 290 });
  expect(resizePaneWidths(widths, "left", 600, 1000)).toEqual({
    left: 290,
    right: 420,
  });
  expect(resizePaneWidths(widths, "right", -100, 1000)).toEqual({
    left: 205,
    right: 220,
  });
});

test("the responsive rail mode includes 700px and the 900px boundary", () => {
  expect(isDesktopPaneLayout(700)).toBe(false);
  expect(isDesktopPaneLayout(900)).toBe(false);
  expect(isDesktopPaneLayout(901)).toBe(true);
});
