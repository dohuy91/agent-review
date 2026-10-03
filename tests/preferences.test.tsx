// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../apps/web/src/App.js";
import {
  chooseTheme,
  selectedTheme,
  openProfiles,
  chooseBase,
  advancedBase,
  openFileActions,
  selectedProject,
} from "./workspace-helpers.js";
import {
  defaultShortcuts,
  loadPreferences,
} from "../apps/web/src/preferences.js";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal("fetch", async (url: any) => {
    const route = String(url);
    let value: any = {};
    if (route === "/api/repositories")
      value = {
        repositories: [
          {
            id: "repo",
            root: "/fixture",
            projectId: "project",
            branch: "main",
            head: "a".repeat(40),
          },
        ],
        selectedRepositoryId: "repo",
        base: "HEAD",
      };
    else if (route.endsWith("/branches")) value = { branches: [] };
    else if (route.includes("/review?"))
      value = {
        id: "rev",
        mode: "full",
        files: ["a.ts", "b.ts"].map((path) => ({
          path,
          status: "M",
          kind: "text",
        })),
      };
    else if (route.includes("/diff?"))
      value = {
        reviewId: "rev",
        path: new URL(route, "http://fixture").searchParams.get("path"),
        hunks: [],
        unsupportedReason: null,
      };
    else if (route.includes("/comments")) value = { comments: [] };
    else if (route.includes("/reviewed")) value = { files: [] };
    else if (route.includes("/profiles")) value = { profiles: {}, revision: 0 };
    else if (route.endsWith("/history")) value = { reviews: [], runs: [] };
    else if (route.endsWith("/project-settings"))
      value = {
        repositoryId: "repo",
        projectId: "project",
        revision: 0,
        settings: { startingFolder: "/fixture", adapter: "codex", skill: null },
      };
    else if (route.endsWith("/remotes")) value = { remotes: [] };
    return { ok: true, status: 200, json: async () => value };
  });
}
async function settings() {
  fixture();
  render(<App />);
  await screen.findByTestId("diff");
  fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
}
test("shortcut collisions are rejected without changing the saved mapping", async () => {
  await settings();
  fireEvent.change(screen.getByLabelText("Next file shortcut"), {
    target: { value: "k" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
  expect(screen.getByRole("alert").textContent).toMatch(
    /collision|already assigned/i,
  );
  expect(localStorage.getItem("agent-review.preferences.v1")).toBeNull();
});
test("configured shortcuts persist, respect fields/modals and replace the default navigation key", async () => {
  await settings();
  fireEvent.change(screen.getByLabelText("Next file shortcut"), {
    target: { value: "x" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.keyDown(screen.getByLabelText("Remote base branch"), { key: "x" });
  expect(document.querySelector(".file-title")?.textContent).toContain("a.ts");
  fireEvent.keyDown(document, { key: "j" });
  expect(document.querySelector(".file-title")?.textContent).toContain("a.ts");
  fireEvent.keyDown(document, { key: "x" });
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "b.ts",
    ),
  );
  const saved = JSON.parse(
    localStorage.getItem("agent-review.preferences.v1")!,
  );
  expect(saved.version).toBe(1);
  expect(saved.shortcuts.nextFile).toBe("x");
  cleanup();
  render(<App />);
  await screen.findByTestId("diff");
  fireEvent.keyDown(document, { key: "x" });
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "b.ts",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
  fireEvent.keyDown(document, { key: "k" });
  expect(document.querySelector(".file-title")?.textContent).toContain("b.ts");
});
test("invalid persisted mapping falls back safely and theme/split preferences survive reload", async () => {
  localStorage.setItem(
    "agent-review.preferences.v1",
    JSON.stringify({
      version: 1,
      shortcuts: { nextFile: "k" },
      dark: "bad",
      split: "bad",
    }),
  );
  fixture();
  render(<App />);
  await screen.findByTestId("diff");
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.keyDown(document, { key: "j" });
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "b.ts",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  chooseTheme("dark");
  cleanup();
  render(<App />);
  await screen.findByTestId("diff");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(screen.getByTestId("diff").classList.contains("split")).toBe(true);
});

test("a remapped close command never consumes text typed into a field", async () => {
  await settings();
  fireEvent.change(screen.getByLabelText("Close drawer or dialog shortcut"), {
    target: { value: "q" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  const body = screen.getByLabelText("Comment body");
  fireEvent.change(body, { target: { value: "question" } });
  fireEvent.keyDown(body, { key: "q" });
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("question");
});

function systemTheme(initialDark: boolean, legacy = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(prefers-color-scheme: dark)");
    return legacy
      ? {
          get matches() {
            return media.matches;
          },
          addListener: (listener: (event: MediaQueryListEvent) => void) =>
            listeners.add(listener),
          removeListener: (listener: (event: MediaQueryListEvent) => void) =>
            listeners.delete(listener),
        }
      : media;
  });
  return {
    listeners,
    change(dark: boolean) {
      media.matches = dark;
      act(() => {
        for (const listener of listeners)
          listener({ matches: dark } as MediaQueryListEvent);
      });
    },
  };
}

test("new preferences follow the system theme and live OS changes", async () => {
  const system = systemTheme(true);
  fixture();
  render(<App />);
  await screen.findByTestId("diff");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(selectedTheme()).toBe("system");
  system.change(false);
  expect(document.documentElement.dataset.theme).toBe("light");
  system.change(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("saving other preferences and reloading preserves System rather than the resolved color", async () => {
  const system = systemTheme(true);
  fixture();
  render(<App />);
  await screen.findByTestId("diff");
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  expect(loadPreferences().theme).toBe("system");
  cleanup();
  system.change(false);
  render(<App />);
  await screen.findByTestId("diff");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(selectedTheme()).toBe("system");
  expect(screen.getByTestId("diff").classList.contains("split")).toBe(true);
});

test.each(["light", "dark"] as const)(
  "explicit %s overrides OS changes and survives reload; System resumes following the OS",
  async (theme) => {
    const system = systemTheme(theme !== "dark");
    fixture();
    render(<App />);
    await screen.findByTestId("diff");
    chooseTheme(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    system.change(theme === "dark");
    system.change(theme !== "dark");
    expect(document.documentElement.dataset.theme).toBe(theme);
    cleanup();
    render(<App />);
    await screen.findByTestId("diff");
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(selectedTheme()).toBe(theme);
    chooseTheme("system");
    expect(document.documentElement.dataset.theme).toBe(
      theme === "light" ? "dark" : "light",
    );
    system.change(theme === "dark");
    expect(document.documentElement.dataset.theme).toBe(theme);
  },
);

test.each([false, true])(
  "legacy dark=%s remains an explicit selection with other settings intact",
  async (dark) => {
    systemTheme(!dark);
    localStorage.setItem(
      "agent-review.preferences.v1",
      JSON.stringify({
        version: 1,
        shortcuts: { ...defaultShortcuts, nextFile: "x" },
        dark,
        split: true,
        paneWidths: { left: 250, right: 340 },
      }),
    );
    fixture();
    render(<App />);
    await screen.findByTestId("diff");
    expect(document.documentElement.dataset.theme).toBe(
      dark ? "dark" : "light",
    );
    expect(selectedTheme()).toBe(dark ? "dark" : "light");
    expect(loadPreferences()).toMatchObject({
      theme: dark ? "dark" : "light",
      shortcuts: { nextFile: "x" },
      split: true,
      paneWidths: { left: 250, right: 340 },
    });
  },
);

test("System falls back to light when matchMedia is unavailable and explicit dark still works", async () => {
  vi.stubGlobal("matchMedia", undefined);
  fixture();
  render(<App />);
  await screen.findByTestId("diff");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(selectedTheme()).toBe("system");
  chooseTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test.each(["modern", "legacy"])(
  "%s system theme listeners update and are removed on unmount and manual override",
  async (api) => {
    const system = systemTheme(true, api === "legacy");
    fixture();
    const view = render(<App />);
    await screen.findByTestId("diff");
    expect(system.listeners.size).toBe(1);
    system.change(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    chooseTheme("light");
    expect(system.listeners.size).toBe(0);
    chooseTheme("system");
    expect(system.listeners.size).toBe(1);
    view.unmount();
    expect(system.listeners.size).toBe(0);
  },
);
