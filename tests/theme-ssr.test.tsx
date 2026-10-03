import React from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import {
  loadPreferences,
  type ThemePreference,
} from "../apps/web/src/preferences.js";
import { useTheme } from "../apps/web/src/useTheme.js";

function Theme({ preference }: { preference: ThemePreference }) {
  return <span>{useTheme(preference) ? "dark" : "light"}</span>;
}

test("theme preferences default to System without browser storage", () => {
  expect(loadPreferences().theme).toBe("system");
});

test.each([
  ["system", "light"],
  ["light", "light"],
  ["dark", "dark"],
] as const)(
  "server-rendered %s theme safely resolves to %s without window",
  (preference, resolved) => {
    expect(renderToString(<Theme preference={preference} />)).toBe(
      `<span>${resolved}</span>`,
    );
  },
);
