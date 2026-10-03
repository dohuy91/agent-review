// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import {
  defaultShortcuts,
  loadPreferences,
  savePreferences,
} from "../apps/web/src/preferences.js";

afterEach(() => localStorage.clear());
const key = "agent-review.preferences.v1";
const original = {
  version: 1 as const,
  shortcuts: { ...defaultShortcuts },
  theme: "dark" as const,
  split: true,
};

test("older version-one preferences get default pane widths without losing settings", () => {
  localStorage.setItem(key, JSON.stringify(original));
  expect(loadPreferences()).toEqual({
    ...original,
    paneWidths: { left: 205, right: 270 },
  });
});

test("pane widths persist with the existing version-one preference key", () => {
  savePreferences({ ...original, paneWidths: { left: 300, right: 380 } });
  expect(loadPreferences()).toEqual({
    ...original,
    paneWidths: { left: 300, right: 380 },
  });
  expect(JSON.parse(localStorage.getItem(key)!).version).toBe(1);
});

test("malformed pane widths fall back individually while numeric widths are bounded", () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      ...original,
      paneWidths: { left: "wide", right: 10000 },
    }),
  );
  expect(loadPreferences()).toEqual({
    ...original,
    paneWidths: { left: 205, right: 520 },
  });
  localStorage.setItem(
    key,
    JSON.stringify({
      ...original,
      paneWidths: { left: -4, right: null },
    }),
  );
  expect(loadPreferences().paneWidths).toEqual({ left: 160, right: 270 });
});

test("saving an older settings payload preserves already resized pane widths", () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      ...original,
      paneWidths: { left: 250, right: 340 },
    }),
  );
  savePreferences({ ...original, theme: "light" });
  expect(loadPreferences()).toEqual({
    ...original,
    theme: "light",
    paneWidths: { left: 250, right: 340 },
  });
});
