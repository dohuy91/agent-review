// @vitest-environment jsdom
import React from "react";
import { test, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import App from "../apps/web/src/App.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const repository = {
  id: "repo",
  root: "/demo",
  projectId: "project",
  branch: "main",
  head: "abc",
};
const files = [
  { path: "a.ts", status: "M", fingerprint: "a", kind: "text" },
  { path: "b.ts", status: "A", fingerprint: "b", kind: "text" },
];
function fixture() {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    calls.push({
      url: String(url),
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    let data: any = {};
    if (String(url) === "/api/repositories")
      data = {
        repositories: [repository],
        selectedRepositoryId: "repo",
        base: "HEAD",
      };
    else if (String(url).includes("/branches"))
      data = { branches: ["main", "feature"], current: "main" };
    else if (String(url).includes("/review?"))
      data = { id: "rev", files, mode: "full", branch: "main" };
    else if (String(url).includes("/diff?"))
      data = {
        reviewId: new URL(String(url), "http://fixture").searchParams.get(
          "reviewId",
        ),
        path: new URL(String(url), "http://fixture").searchParams.get("path"),
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              {
                type: "delete",
                text: "const old = 1;",
                oldLine: 1,
                newLine: null,
              },
              {
                type: "delete",
                text: "const gone = 2;",
                oldLine: 2,
                newLine: null,
              },
              {
                type: "add",
                text: "const fresh = 3;",
                oldLine: null,
                newLine: 1,
              },
            ],
          },
        ],
        oldContent: "const old = 1;\nconst gone = 2;",
        newContent: "const fresh = 3;",
      };
    else if (String(url).includes("/comments")) data = { comments: [] };
    else if (String(url).includes("/reviewed"))
      data = {
        files:
          opts.method === "PUT"
            ? [
                {
                  path: JSON.parse(opts.body).path,
                  fingerprint: "a",
                  reviewed: JSON.parse(opts.body).reviewed,
                },
              ]
            : [],
      };
    else if (String(url).includes("/profiles"))
      data = { profiles: {}, effective: null, source: null, revision: 0 };
    return { ok: true, status: 200, json: async () => data };
  });
  return calls;
}
test("lazy selected diff, deleted old-side range, comment payload and appearance controls", async () => {
  const calls = fixture();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  expect(calls.filter((c) => c.url.includes("/diff?"))).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "old line 2" }), {
    shiftKey: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Please retain this behavior" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(calls.find((c) => c.body?.body)?.body).toMatchObject({
      reviewId: "rev",
      path: "a.ts",
      side: "old",
      startLine: 1,
      endLine: 2,
      body: "Please retain this behavior",
      severity: "info",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  expect(screen.getByTestId("diff").classList.contains("split")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(getComputedStyle(document.querySelector(".cm-line span")!).color).toBe(
    "rgb(199, 146, 234)",
  );
});
test("keyboard leaves typing alone and selects next file outside inputs; mode refreshes", async () => {
  const calls = fixture();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  const input = screen.getByLabelText("Comment body");
  fireEvent.keyDown(input, { key: "j" });
  expect(calls.filter((c) => c.url.includes("/diff?"))).toHaveLength(1);
  fireEvent.keyDown(document, { key: "j" });
  await waitFor(() =>
    expect(calls.filter((c) => c.url.includes("/diff?"))).toHaveLength(2),
  );
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await waitFor(() =>
    expect(calls.some((c) => c.url.includes("mode=staged"))).toBe(true),
  );
  expect(
    (screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
test("drawer edit resolve reopen severity and delete use scoped lifecycle contracts", async () => {
  fixture();
  const original = globalThis.fetch;
  let note: any = {
    id: "note",
    path: "a.ts",
    side: "old",
    startLine: 1,
    endLine: 2,
    body: "Existing note",
    severity: "info",
    status: "open",
    attachment: "current",
    attachedRange: { startLine: 1, endLine: 2 },
    historicalContent: "available",
  };
  const mutations: any[] = [];
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (String(url).includes("/comments")) {
      if (opts.method === "PATCH") {
        const patch = JSON.parse(opts.body);
        mutations.push(patch);
        note = { ...note, ...patch };
      }
      if (opts.method === "DELETE") {
        mutations.push("delete");
        note = null;
      }
      return {
        ok: true,
        status: opts.method === "DELETE" ? 204 : 200,
        json: async () => ({ comments: note ? [note] : [] }),
      } as Response;
    }
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Comments 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Edited body" },
  });
  fireEvent.change(screen.getByLabelText("Comment severity"), {
    target: { value: "error" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await screen.findByText("Edited body");
  expect(mutations[0]).toEqual({ body: "Edited body", severity: "error" });
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
  await screen.findByRole("button", { name: "Reopen" });
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await screen.findByRole("button", { name: "Resolve" });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByText("Edited body")).toBeNull());
  expect(mutations).toContainEqual({ status: "resolved" });
  expect(mutations).toContainEqual({ status: "open" });
  expect(mutations).toContain("delete");
});
test("reviewed status refresh resets and profile saves explicit scope locator digest", async () => {
  const calls = fixture();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "○ Mark reviewed" }));
  await screen.findByRole("button", { name: "✓ Reviewed" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByRole("button", { name: "○ Mark reviewed" });
  fireEvent.click(screen.getByRole("button", { name: "Fix profiles" }));
  fireEvent.change(screen.getByLabelText("Profile scope"), {
    target: { value: "worktree" },
  });
  fireEvent.change(screen.getByLabelText("Skill locator"), {
    target: { value: "skill://local/fix" },
  });
  fireEvent.change(screen.getByLabelText("Skill digest"), {
    target: { value: "a".repeat(64) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.body?.profile?.digest === "a".repeat(64) &&
          c.body.scope === "worktree",
      ),
    ).toBe(true),
  );
  expect(calls.find((c) => c.body?.reviewed)?.body).toEqual({
    reviewId: "rev",
    path: "a.ts",
    reviewed: true,
  });
});
function deferredResponse() {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((done) => (resolve = done)),
    resolve: (data: unknown) =>
      resolve({ ok: true, status: 200, json: async () => data } as Response),
  };
}
const savedNote = {
  id: "note",
  path: "a.ts",
  side: "old",
  startLine: 1,
  endLine: 2,
  body: "Existing note",
  severity: "info",
  status: "open",
  attachment: "current",
  attachedRange: { startLine: 1, endLine: 2 },
  historicalContent: "available",
};
test("historic branch selection opens scoped history ID and disables every historical mutation control", async () => {
  const calls = fixture();
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url);
    if (route.endsWith("/history"))
      return {
        ok: true,
        json: async () => ({
          reviews: [
            {
              id: "historic",
              base: "stored-base",
              mode: "branch",
              head: "old-head",
              acceptedAt: "now",
              historicalContent: "git-objects-only",
            },
          ],
          runs: [],
        }),
      } as Response;
    if (route.endsWith("/history/historic/review")) {
      calls.push({ url: route, body: null });
      return {
        ok: true,
        json: async () => ({
          id: "historic-observation",
          historical: true,
          files,
          mode: "branch",
          branch: "old-branch",
          head: "old-head",
        }),
      } as Response;
    }
    if (route.includes("/comments"))
      return {
        ok: true,
        json: async () => ({ comments: [savedNote] }),
      } as Response;
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(
    await screen.findByRole("button", { name: /branch · detached · old-head/ }),
  );
  await screen.findByText(/Historical read-only/);
  expect(calls.some((c) => c.url.endsWith("/history/historic/review"))).toBe(
    true,
  );
  expect(
    (screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "○ Mark reviewed",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Fix profiles" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Configure profile",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Send to agent" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Comments 1" }));
  for (const name of ["Edit", "Resolve", "Delete"])
    expect(
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
});

test("selecting mutable history refreshes current endpoints even when comparison metadata already matches", async () => {
  const calls = fixture();
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (String(url).endsWith("/history"))
      return {
        ok: true,
        json: async () => ({
          reviews: [
            {
              id: "mutable",
              base: "HEAD",
              mode: "full",
              head: "old-head",
              acceptedAt: "now",
              historicalContent: "unavailable",
            },
          ],
          runs: [],
        }),
      } as Response;
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  const before = calls.filter((c) => c.url.includes("/review?")).length;
  fireEvent.click(
    await screen.findByRole("button", { name: /full · detached · old-head/ }),
  );
  await waitFor(() =>
    expect(calls.filter((c) => c.url.includes("/review?")).length).toBe(
      before + 1,
    ),
  );
});
test("late comment follow-up cannot replace a refreshed observation", async () => {
  fixture();
  const original = fetch;
  const held = deferredResponse();
  let posted = false,
    loads = 0;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (String(url).includes("/comments") && opts.method === "POST") {
      posted = true;
      return { ok: true, status: 201, json: async () => savedNote } as Response;
    }
    if (String(url).includes("/comments?") && posted) {
      loads++;
      if (loads === 1) return held.promise;
      return {
        ok: true,
        status: 200,
        json: async () => ({ comments: [] }),
      } as Response;
    }
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "pending" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() => expect(loads).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await waitFor(() => expect(loads).toBe(2));
  await screen.findByRole("button", { name: "old line 1" });
  held.resolve({ comments: [savedNote] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByRole("button", { name: "Comments 0" })).toBeTruthy();
});
test("reviewed rapid clicks serialize and consume authoritative result", async () => {
  fixture();
  const original = fetch;
  const held = deferredResponse();
  let marks = 0;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (String(url).endsWith("/reviewed") && opts.method === "PUT") {
      marks++;
      return held.promise;
    }
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  const button = screen.getByRole("button", { name: "○ Mark reviewed" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(marks).toBe(1);
  held.resolve({ files: [{ path: "a.ts", fingerprint: "a", reviewed: true }] });
  await screen.findByRole("button", { name: "✓ Reviewed" });
});
test("late reviewed and profile results cannot replace a changed mode", async () => {
  fixture();
  const original = fetch;
  const mark = deferredResponse(),
    profile = deferredResponse();
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    if (String(url).endsWith("/reviewed") && opts.method === "PUT")
      return mark.promise;
    if (String(url).endsWith("/profiles") && opts.method === "PUT")
      return profile.promise;
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "○ Mark reviewed" }));
  fireEvent.click(screen.getByRole("button", { name: "Fix profiles" }));
  fireEvent.change(screen.getByLabelText("Skill locator"), {
    target: { value: "skill://old" },
  });
  fireEvent.change(screen.getByLabelText("Skill digest"), {
    target: { value: "a".repeat(64) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await screen.findByRole("button", { name: "old line 1" });
  mark.resolve({ files: [{ path: "a.ts", reviewed: true }] });
  profile.resolve({
    profiles: {},
    effective: { locator: "skill://old", digest: "a".repeat(64) },
    source: "project",
    revision: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("button", { name: "✓ Reviewed" })).toBeNull();
  expect(screen.queryByText("skill://old")).toBeNull();
});
test("edit resets on file navigation, Add starts new draft, Escape clears editing", async () => {
  const calls = fixture();
  const original = fetch;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) =>
    String(url).includes("/comments?")
      ? ({
          ok: true,
          status: 200,
          json: async () => ({ comments: [savedNote] }),
        } as Response)
      : original(url, opts),
  );
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Comments 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.keyDown(document, { key: "j" });
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "b.ts",
    ),
  );
  await screen.findByRole("button", { name: "old line 1" });
  expect(screen.queryByLabelText("Comment body")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "B note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(
      calls.some((c) => c.body?.body === "B note" && c.body.path === "b.ts"),
    ).toBe(true),
  );
  fireEvent.keyDown(document, { key: "k" });
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "a.ts",
    ),
  );
  screen.getByRole("button", { name: "Edit" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.keyDown(screen.getByLabelText("Comment body"), { key: "Escape" });
  expect(screen.queryByLabelText("Comment body")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Edit" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("");
});
test("all notes exposes outdated files absent from changed list and lifecycle actions", async () => {
  fixture();
  const original = fetch;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) =>
    String(url).includes("/comments?")
      ? ({
          ok: true,
          status: 200,
          json: async () => ({
            comments: [
              {
                ...savedNote,
                path: "clean.ts",
                attachment: "outdated",
                attachedRange: null,
                historicalContent: "unavailable",
                mode: "working",
                base: "baseoid",
                head: "headoid",
                branch: "refs/heads/main",
              },
            ],
          }),
        } as Response)
      : original(url, opts),
  );
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Comments 1" }));
  fireEvent.click(screen.getByRole("button", { name: "All notes" }));
  expect(screen.getByText("clean.ts")).toBeTruthy();
  expect(screen.getByText("Existing note")).toBeTruthy();
  expect(screen.getByText(/historical content unavailable/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Existing note");
});
test("composer focuses for typing and Escape from input restores focus; modal contains focus and blocks background shortcuts", async () => {
  const calls = fixture();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  const add = screen.getByRole("button", { name: "Add comment" });
  add.focus();
  fireEvent.keyDown(add, { key: "c" });
  expect(document.activeElement).toBe(screen.getByLabelText("Comment body"));
  fireEvent.keyDown(screen.getByLabelText("Comment body"), { key: "Escape" });
  expect(screen.queryByLabelText("Comment body")).toBeNull();
  expect(document.activeElement).toBe(add);
  const open = screen.getByRole("button", { name: "Fix profiles" });
  open.focus();
  fireEvent.click(open);
  const dialog = screen.getByRole("dialog");
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "j" });
  expect(calls.filter((c) => c.url.includes("/diff?"))).toHaveLength(1);
  const last = screen.getByRole("button", { name: "Remove override" });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(dialog.querySelector(".modal-close"));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(screen.getByLabelText("Skill locator"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(open);
});
test.each(["edit", "create"])(
  "delayed %s completion preserves a newly opened edit body and target",
  async (kind) => {
    fixture();
    const original = fetch,
      held = deferredResponse();
    let pending = false;
    const writes: { url: string; body: any }[] = [];
    const second = { ...savedNote, id: "second", body: "Second note" };
    vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
      if (String(url).includes("/comments?"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            comments: [
              {
                ...savedNote,
                body: pending ? "First pending save" : savedNote.body,
              },
              second,
            ],
          }),
        } as Response;
      if (
        String(url).includes("/comments") &&
        ["POST", "PATCH"].includes(opts.method)
      ) {
        const body = JSON.parse(opts.body);
        writes.push({ url: String(url), body });
        if (!pending) {
          pending = true;
          return held.promise;
        }
        return { ok: true, status: 200, json: async () => second } as Response;
      }
      return original(url, opts);
    });
    render(<App />);
    await screen.findByRole("button", { name: "old line 1" });
    fireEvent.click(screen.getByRole("button", { name: "Comments 2" }));
    if (kind === "edit")
      fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    else {
      fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    }
    fireEvent.change(screen.getByLabelText("Comment body"), {
      target: { value: "First pending save" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(pending).toBe(true));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText("Comment body"), {
      target: { value: "Unsaved second draft" },
    });
    held.resolve(savedNote);
    await waitFor(() =>
      expect(document.querySelector(".comment p")?.textContent).toBe(
        "First pending save",
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Save comment" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(
      (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
    ).toBe("Unsaved second draft");
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() =>
      expect(writes[1]).toEqual({
        url: "/api/repositories/repo/comments/second?reviewId=rev",
        body: { body: "Unsaved second draft", severity: "info" },
      }),
    );
  },
);

test("watch invalidation retains draft body, path and requires a new range", async () => {
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
  const calls = fixture();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Unsaved watch draft" },
  });
  const prior = calls.filter((c) => c.url.includes("/review?")).length;
  invalidate();
  await waitFor(() =>
    expect(
      calls.filter((c) => c.url.includes("/review?")).length,
    ).toBeGreaterThan(prior),
  );
  await waitFor(() =>
    expect(
      screen.getByText("Range changed; select current lines before saving."),
    ).toBeTruthy(),
  );
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Unsaved watch draft");
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("watch keeps disappeared draft path pinned and preserves diff scroll", async () => {
  let invalidate: () => void = () => {};
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: any;
      constructor(url: string) {
        if (!url.includes("/agents/"))
          invalidate = () =>
            this.onmessage?.({ data: '{"type":"invalidate"}' });
      }
      close() {}
    },
  );
  fixture();
  const original = globalThis.fetch;
  let disappeared = false;
  vi.stubGlobal("fetch", async (url: any, opts: any) => {
    const response = await original(url, opts);
    if (disappeared && String(url).includes("/review?"))
      return {
        ok: true,
        json: async () => ({
          id: "new",
          files: [files[1]],
          branch: "main",
          mode: "full",
        }),
      };
    return response;
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Pinned draft" },
  });
  const scroll = document.querySelector(".diff-scroll")!;
  scroll.scrollTop = 125;
  invalidate();
  await screen.findByText("Range changed; select current lines before saving.");
  await waitFor(() => expect(scroll.scrollTop).toBe(125));
  disappeared = true;
  invalidate();
  await screen.findByText(
    "Selected file disappeared. Choose a file explicitly.",
  );
  expect(document.querySelector(".file-title strong")?.textContent).toBe(
    "a.ts",
  );
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Pinned draft");
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("range selected on old view during pending watch refresh must be reselected", async () => {
  let invalidate: () => void = () => {},
    finish: (v: any) => void = () => {};
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
  fixture();
  const original = globalThis.fetch;
  let pending = false;
  vi.stubGlobal("fetch", async (url: any, opts: any) => {
    if (pending && String(url).includes("/review?"))
      return await new Promise((r) => (finish = r));
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Range race draft" },
  });
  pending = true;
  invalidate();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  finish({
    ok: true,
    json: async () => ({
      id: "new-range",
      files,
      branch: "main",
      mode: "full",
    }),
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Save comment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Range race draft");
});

test("retained old gutter cannot save under fresh review while fresh diff is pending", async () => {
  let invalidate: () => void = () => {},
    finishDiff: (v: any) => void = () => {};
  let pendingDiff = false;
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
  const calls = fixture();
  const original = fetch;
  let fresh = false;
  vi.stubGlobal("fetch", async (url: any, opts: any) => {
    if (fresh && String(url).includes("/review?"))
      return {
        ok: true,
        json: async () => ({
          id: "fresh",
          files,
          branch: "main",
          mode: "full",
        }),
      };
    if (
      String(url).includes("/diff?") &&
      String(url).includes("reviewId=fresh")
    ) {
      pendingDiff = true;
      return await new Promise((r) => (finishDiff = r));
    }
    return original(url, opts);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Retained draft" },
  });
  fresh = true;
  invalidate();
  await waitFor(() => expect(pendingDiff).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  expect(
    (screen.getByRole("button", { name: "old line 1" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    calls.some(
      (c) => c.url.endsWith("/comments") && c.body?.body === "Retained draft",
    ),
  ).toBe(false);
  finishDiff({
    ok: true,
    json: async () => ({
      reviewId: "fresh",
      path: "a.ts",
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            {
              type: "add",
              text: "Current fresh text",
              oldLine: null,
              newLine: 1,
            },
          ],
        },
      ],
      oldContent: "old",
      newContent: "Current fresh text",
    }),
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "new line 1" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(
    (screen.getByRole("button", { name: "Save comment" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "new line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.body?.reviewId === "fresh" && c.body?.body === "Retained draft",
      ),
    ).toBe(true),
  );
});

test("agent confirmation Escape preserves draft and restores main modal keyboard semantics", async () => {
  fixture();
  const original = fetch;
  const profile = {
    effective: { locator: "exact", digest: "d" },
    profiles: {},
    revision: 1,
  };
  vi.stubGlobal("fetch", async (url: any, opts: any) => {
    const u = String(url);
    const data =
      u === "/api/agents"
        ? {
            agents: [
              {
                id: "codex",
                available: true,
                provider: {
                  identity: "fixture",
                  label: "Fixture only — no provider",
                },
              },
            ],
            writesEnabled: true,
          }
        : u === "/api/skills"
          ? { skills: [{ name: "Exact", locator: "exact", digest: "d" }] }
          : u.includes("/profiles?")
            ? profile
            : u.includes("/comments?")
              ? { comments: [savedNote] }
              : u.includes("/export?")
                ? {
                    target: {
                      worktreeRoot: "/fixture",
                      branch: "main",
                      head: "full-fixture-head",
                    },
                    profile,
                  }
                : undefined;
    return data === undefined
      ? original(url, opts)
      : { ok: true, json: async () => data };
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Preserve on Escape" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  const send = screen.getByRole("button", { name: "Send to agent" });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  send.focus();
  fireEvent.click(send);
  const dialog = await screen.findByRole("dialog", {
    name: "Confirm agent transmission",
  });
  await waitFor(() =>
    expect(document.querySelector(".workspace")?.hasAttribute("inert")).toBe(
      true,
    ),
  );
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.querySelector(".workspace")?.hasAttribute("inert")).toBe(
    false,
  );
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Preserve on Escape");
  expect(document.activeElement).toBe(send);
});
