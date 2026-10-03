// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
function fixture() {
  const writes: { url: string; body: any }[] = [];
  let notes: any[] = [];
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url);
    let data: any = {};
    if (route === "/api/repositories")
      data = {
        repositories: [
          {
            id: "repo",
            root: "/fixture",
            projectId: "p",
            branch: "main",
            head: "abc",
          },
        ],
        selectedRepositoryId: "repo",
        base: "HEAD",
      };
    else if (route.endsWith("/branches")) data = { branches: ["main"] };
    else if (route.includes("/review?"))
      data = {
        id: "rev",
        mode: "full",
        branch: "main",
        files: [{ path: "a.ts", status: "M", kind: "text" }],
      };
    else if (route.includes("/diff?"))
      data = {
        reviewId: "rev",
        path: "a.ts",
        hunks: [
          {
            oldStart: 1,
            oldCount: 3,
            newStart: 1,
            newCount: 3,
            lines: [
              {
                type: "context",
                text: "const start = 1",
                oldLine: 1,
                newLine: 1,
              },
              {
                type: "delete",
                text: "const old = 2",
                oldLine: 2,
                newLine: null,
              },
              {
                type: "add",
                text: "const fresh = 2",
                oldLine: null,
                newLine: 2,
              },
              {
                type: "context",
                text: "const end = 3",
                oldLine: 3,
                newLine: 3,
              },
            ],
          },
        ],
      };
    else if (route.includes("/comments")) {
      if (opts.method === "POST") {
        const body = JSON.parse(opts.body);
        writes.push({ url: route, body });
        notes.push({
          id: "note",
          ...body,
          status: "open",
          attachment: "current",
          attachedRange: { startLine: body.startLine, endLine: body.endLine },
        });
      }
      if (opts.method === "PATCH") {
        const body = JSON.parse(opts.body);
        writes.push({ url: route, body });
        notes = notes.map((n) => ({ ...n, ...body }));
      }
      data = { comments: notes };
    } else if (route.includes("/profiles"))
      data = { profiles: {}, effective: null, revision: 0 };
    else if (route.includes("/reviewed")) data = { files: [] };
    else if (route.endsWith("/history")) data = { reviews: [], runs: [] };
    else if (route.endsWith("/project-settings"))
      data = {
        repositoryId: "repo",
        projectId: "project",
        revision: 0,
        settings: { startingFolder: "/fixture", adapter: "codex", skill: null },
      };
    else if (route.endsWith("/remotes")) data = { remotes: [] };
    return { ok: true, status: 200, json: async () => data };
  });
  return writes;
}
async function load() {
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
}
function body() {
  return screen.getByLabelText("Comment body") as HTMLTextAreaElement;
}

test("sidebar composer remains reachable across note collapse and Files/Notes switches", async () => {
  fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(body(), {
    target: { value: "Keep draft through collapse" },
  });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "warning" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review notes 0" }));
  expect(
    screen
      .getByRole("button", { name: "Review notes 0" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(body().value).toBe("Keep draft through collapse");
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(body().value).toBe("Keep draft through collapse");
  fireEvent.click(screen.getByRole("button", { name: "Review Comments 0" }));
  expect(
    (screen.getByLabelText("Comment severity") as HTMLSelectElement).value,
  ).toBe("warning");
  expect(
    within(document.querySelector(".aux") as HTMLElement).queryByRole(
      "region",
      { name: "Git actions" },
    ),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Fix with Agent" })).toBeTruthy();
});

test("inline old range composer shares one draft with sidebar and view switches, then saves exact target", async () => {
  const writes = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "old line 2" }), {
    shiftKey: true,
  });
  const inline = screen.getByTestId("inline-comment-composer");
  expect(inline.contains(body())).toBe(true);
  expect(inline.getAttribute("data-line")).toBe("2");
  fireEvent.change(body(), { target: { value: "Inline range note" } });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "error" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Comment in sidebar" }));
  expect(document.querySelector(".aux")?.contains(body())).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Continue inline" }));
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  expect(screen.getByTestId("inline-comment-composer").contains(body())).toBe(
    true,
  );
  expect(body().value).toBe("Inline range note");
  expect(screen.getAllByLabelText("Comment body")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(writes[0]?.body).toMatchObject({
      path: "a.ts",
      side: "old",
      startLine: 1,
      endLine: 2,
      body: "Inline range note",
      severity: "error",
    }),
  );
});

test("selecting different lines cannot silently retarget a nonempty draft", async () => {
  const writes = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(body(), { target: { value: "Pinned original target" } });
  fireEvent.click(screen.getByRole("button", { name: "new line 3" }));
  expect(screen.getByText(/Draft remains on old lines 2/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(writes[0]?.body).toMatchObject({
      side: "old",
      startLine: 2,
      endLine: 2,
    }),
  );
});

test("saved inline marker expands common edit/resolve lifecycle and sidebar sync", async () => {
  const writes = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "new line 2" }));
  fireEvent.change(body(), { target: { value: "Inline saved" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  const marker = await screen.findByRole("button", {
    name: /new lines 2.*1 note/i,
  });
  fireEvent.click(marker);
  const thread = document.querySelector(
    '.diff [data-comment-id="note"]',
  ) as HTMLElement;
  fireEvent.click(within(thread).getByRole("button", { name: "Edit" }));
  expect(screen.getByTestId("inline-comment-composer").contains(body())).toBe(
    true,
  );
  fireEvent.change(body(), { target: { value: "Inline edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Comment in sidebar" }));
  expect(body().value).toBe("Inline edited");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(writes.some((w) => w.body.body === "Inline edited")).toBe(true),
  );
  fireEvent.click(within(thread).getByRole("button", { name: "Resolve" }));
  await waitFor(() =>
    expect(within(thread).getByRole("button", { name: "Reopen" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review Comments 1" }));
  expect(
    within(document.querySelector(".aux") as HTMLElement).getByRole("button", {
      name: "Reopen",
    }),
  ).toBeTruthy();
});

test("explicit retarget preserves body/severity and updates the shared inline/sidebar range", async () => {
  const writes = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 2" }));
  fireEvent.change(body(), { target: { value: "Move this deliberately" } });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "warning" },
  });
  fireEvent.click(screen.getByRole("button", { name: "new line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "new line 3" }), {
    shiftKey: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Use selected lines" }));
  expect(
    screen.getByTestId("inline-comment-composer").getAttribute("data-line"),
  ).toBe("3");
  expect(body().value).toBe("Move this deliberately");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(writes[0]?.body).toMatchObject({
      side: "new",
      startLine: 1,
      endLine: 3,
      severity: "warning",
    }),
  );
});

test("typing while an inline save is pending cannot clear newer draft text or severity", async () => {
  fixture();
  const original = fetch;
  let release!: () => void;
  let started = false;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (opts.method === "POST" && String(url).endsWith("/comments")) {
      started = true;
      await new Promise<void>((resolve) => (release = resolve));
    }
    return original(url, opts);
  });
  await load();
  fireEvent.click(screen.getByRole("button", { name: "new line 2" }));
  fireEvent.change(body(), { target: { value: "First snapshot" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(started).toBe(true));
  fireEvent.change(body(), { target: { value: "New unsaved wording" } });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "warning" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Comment in sidebar" }));
  release();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Save comment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(body().value).toBe("New unsaved wording");
  expect(
    (screen.getByLabelText("Comment severity") as HTMLSelectElement).value,
  ).toBe("warning");
});

test("inline live refresh keeps the draft reachable in the sidebar and requires current-line reselection", async () => {
  fixture();
  let invalidate: () => void = () => {};
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: any;
      constructor() {
        invalidate = () => this.onmessage?.({ data: '{"type":"invalidate"}' });
      }
      close() {}
    },
  );
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 2" }));
  fireEvent.change(body(), { target: { value: "Retain inline watch draft" } });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "error" },
  });
  invalidate();
  await screen.findByText("Range changed; select current lines before saving.");
  expect(document.querySelector(".aux")?.contains(body())).toBe(true);
  expect(body().value).toBe("Retain inline watch draft");
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "new line 3" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "new line 3" }));
  fireEvent.click(screen.getByRole("button", { name: "Use selected lines" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue inline" }));
  expect(
    screen.getByTestId("inline-comment-composer").getAttribute("data-line"),
  ).toBe("3");
  expect(body().value).toBe("Retain inline watch draft");
  expect(
    (screen.getByLabelText("Comment severity") as HTMLSelectElement).value,
  ).toBe("error");
});

test("desktop pane controls persist widths without losing appearance settings and rails omit resizing at700px", async () => {
  fixture();
  vi.stubGlobal("innerWidth", 1200);
  await load();
  const left = screen.getByRole("separator", {
    name: "Resize changed files pane",
  });
  fireEvent.keyDown(left, { key: "ArrowRight" });
  expect(left.getAttribute("aria-valuenow")).toBe("215");
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  chooseTheme("dark");
  const saved = JSON.parse(
    localStorage.getItem("agent-review.preferences.v1")!,
  );
  expect(saved.paneWidths).toEqual({ left: 215, right: 270 });
  cleanup();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  expect(
    screen
      .getByRole("separator", { name: "Resize changed files pane" })
      .getAttribute("aria-valuenow"),
  ).toBe("215");
  expect(document.documentElement.dataset.theme).toBe("dark");
  vi.stubGlobal("innerWidth", 700);
  fireEvent(window, new Event("resize"));
  expect(
    screen
      .getByRole("separator", { name: "Resize changed files pane" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  expect(
    (document.querySelector(".workspace") as HTMLElement).style
      .gridTemplateColumns,
  ).toBe("minmax(0, 1fr)");
  fireEvent.click(screen.getByRole("button", { name: "Notes" }));
  expect(document.querySelector(".app")?.classList.contains("panel-open")).toBe(
    true,
  );
});

test("keyboard Add comment binds the latest selected range and keeps an existing draft", async () => {
  const writes = fixture();
  await load();
  const gutter = screen.getByRole("button", { name: "new line 2" });
  fireEvent.click(gutter);
  fireEvent.keyDown(document, { key: "c" });
  expect(document.activeElement).toBe(body());
  fireEvent.change(body(), { target: { value: "Keyboard-selected draft" } });
  fireEvent.keyDown(document, { key: "c" });
  expect(body().value).toBe("Keyboard-selected draft");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(writes[0]?.body).toMatchObject({
      side: "new",
      startLine: 2,
      endLine: 2,
    }),
  );
});

test("an edited inline note retains its draft across collapse, pane and theme switches", async () => {
  fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "new line 2" }));
  fireEvent.change(body(), { target: { value: "Saved before editing" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /new lines 2.*1 note/i }),
  );
  const thread = document.querySelector(
    '.diff [data-comment-id="note"]',
  ) as HTMLElement;
  fireEvent.click(within(thread).getByRole("button", { name: "Edit" }));
  fireEvent.change(body(), { target: { value: "Unsaved edited draft" } });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "error" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Comment in sidebar" }));
  fireEvent.click(screen.getByRole("button", { name: "Review notes 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  chooseTheme("dark");
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  expect(body().value).toBe("Unsaved edited draft");
  expect(
    (screen.getByLabelText("Comment severity") as HTMLSelectElement).value,
  ).toBe("error");
  fireEvent.click(screen.getByRole("button", { name: "Continue inline" }));
  expect(screen.getByTestId("inline-comment-composer").contains(body())).toBe(
    true,
  );
});

test("pending refresh disables an edited note save while preserving its text", async () => {
  fixture();
  const original = fetch;
  let hold = false,
    finish!: (value: any) => void;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (hold && String(url).includes("/review?"))
      return new Promise((resolve) => (finish = resolve));
    return original(url, opts);
  });
  await load();
  fireEvent.click(screen.getByRole("button", { name: "new line 2" }));
  fireEvent.change(body(), { target: { value: "Before refresh" } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /new lines 2.*1 note/i }),
  );
  const thread = document.querySelector(
    '.diff [data-comment-id="note"]',
  ) as HTMLElement;
  fireEvent.click(within(thread).getByRole("button", { name: "Edit" }));
  fireEvent.change(body(), { target: { value: "Edited during refresh" } });
  hold = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(body().value).toBe("Edited during refresh");
  hold = false;
  finish(await original("/api/repositories/repo/review?base=HEAD&mode=full"));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Save comment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(body().value).toBe("Edited during refresh");
});
