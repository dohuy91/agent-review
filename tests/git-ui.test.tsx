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
import type { ReviewMode } from "../packages/shared/src/index.js";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const repo = {
  id: "repo",
  root: "/fixture/worktree",
  gitDir: "/fixture/worktree/.git",
  commonDir: "/fixture/worktree/.git",
  projectId: "project",
  branch: "refs/heads/main",
  head: "a".repeat(40),
};
const files = ["a.ts", "b.ts"].map((path) => ({
  path,
  oldPath: null,
  status: "M",
  kind: "text",
  fingerprint: path,
  oldOid: "old",
  newOid: "new",
  oldMode: "100644",
  newMode: "100644",
}));
function deferred() {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((r) => (resolve = r)),
    resolve: (value: unknown, status = 200) => resolve(response(value, status)),
  };
}
function response(value: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => value } as Response;
}
function fixture(
  options: {
    mode?: ReviewMode;
    writes?: boolean;
    operation?: string;
    historical?: boolean;
  } = {},
) {
  const calls: { url: string; method: string; body: any }[] = [];
  let counter = 0;
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    const route = String(url),
      method = init.method || "GET",
      body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: route, method, body });
    if (route === "/api/repositories")
      return response({
        repositories: [repo],
        selectedRepositoryId: repo.id,
        base: "HEAD",
        mode: options.mode || "working",
        errors: [],
      });
    if (route.endsWith("/selection")) return response({ ok: true });
    if (route.endsWith("/branches"))
      return response({ branches: ["main"], current: "refs/heads/main" });
    if (route.includes("/review?")) {
      counter++;
      return response({
        id: `review-${counter}`,
        repositoryId: repo.id,
        fingerprint: `fingerprint-${counter}`,
        base: "HEAD",
        mergeBase: repo.head,
        head: repo.head,
        branch: repo.branch,
        mode: new URL(route, "http://fixture").searchParams.get("mode"),
        files,
        historical: options.historical,
      });
    }
    if (route.includes("/diff?")) {
      const query = new URL(route, "http://fixture").searchParams;
      return response({
        reviewId: query.get("reviewId"),
        path: query.get("path"),
        fingerprint: "diff",
        oldContent: "old\n",
        newContent: "new\n",
        unsupportedReason: null,
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [
              { type: "delete", text: "old", oldLine: 1, newLine: null },
              { type: "add", text: "new", oldLine: null, newLine: 1 },
            ],
          },
        ],
      });
    }
    if (route.includes("/comments")) return response({ comments: [] });
    if (route.includes("/reviewed")) return response({ files: [] });
    if (route.includes("/profiles"))
      return response({
        profiles: {},
        revision: 0,
        effective: null,
        source: null,
      });
    if (route.endsWith("/capabilities"))
      return response({
        writesEnabled: options.writes !== false,
        fetchEnabled: options.writes !== false,
        reason:
          options.writes === false
            ? "Writes are disabled for this environment"
            : null,
        hunkStageMode: "working",
        hunkUnstageMode: "staged",
      });
    if (route.endsWith("/remotes"))
      return response({
        remotes: [
          {
            name: "origin",
            url: "https://example.test/repo.git",
            transport: "https",
            fetchAvailable: true,
            reason: null,
          },
        ],
      });
    if (route.endsWith("/discard-preview"))
      return response({
        previewId: "preview",
        target: {
          repositoryId: repo.id,
          worktreeRoot: repo.root,
          gitDir: repo.gitDir,
          commonDir: repo.commonDir,
          branch: repo.branch,
          head: repo.head,
          reviewFingerprint: "fingerprint-1",
        },
        path: body.path,
        fingerprint: "discard",
        operation: options.operation || "restore-index",
      });
    if (route.endsWith("/git") || route.endsWith("/discard"))
      return response({ ok: true, changed: true });
    if (route.endsWith("/commit"))
      return response({ ok: true, changed: true, commit: "b".repeat(40) });
    if (route.endsWith("/fetch"))
      return response({ ok: true, remote: body.remote });
    if (route.endsWith("/history")) return response({ reviews: [], runs: [] });
    return response({ adapters: [], skills: [] });
  });
  return calls;
}
async function load() {
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  await screen.findByText("https://example.test/repo.git");
}
test("whole-file and working hunk actions use the exact observation/path then preserve draft text and invalidate its range", async () => {
  const calls = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.body?.action === "stage" &&
          c.body.hunkIndex === 0 &&
          c.body.path === "a.ts" &&
          c.body.reviewId === "review-1",
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(calls.filter((c) => c.url.includes("/review?")).length).toBe(2),
  );
  await screen.findByRole("button", { name: "old line 1" });
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Keep this draft");
  expect(
    screen
      .getByRole("button", { name: "Save comment" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stage file" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.body?.action === "stage" &&
          c.body.hunkIndex === undefined &&
          c.body.reviewId === "review-2",
      ),
    ).toBe(true),
  );
});
test.each(["restore-index", "delete-untracked"])(
  "discard %s previews exact target before explicit confirmation",
  async (operation) => {
    const calls = fixture({ operation });
    await load();
    fireEvent.click(screen.getByRole("button", { name: "Discard file" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm discard",
    });
    expect(dialog.textContent).toContain(repo.root);
    expect(dialog.textContent).toContain("a.ts");
    expect(dialog.textContent).toContain(repo.branch);
    expect(dialog.textContent).toContain(repo.head);
    expect(dialog.textContent).toMatch(
      operation === "delete-untracked"
        ? /Git cannot restore it/
        : /unstaged changes.*staged\/index version/i,
    );
    expect(calls.filter((c) => c.url.endsWith("/discard"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/discard"))?.body).toEqual({
        previewId: "preview",
        confirmed: true,
      }),
    );
  },
);
test("staged commit includes only explicitly checked paths and the authored message", async () => {
  const calls = fixture({ mode: "staged" });
  await load();
  expect(
    screen
      .getByRole("button", { name: "Commit selected" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("Commit a.ts"));
  fireEvent.change(screen.getByLabelText("Commit message"), {
    target: { value: "Selected change" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Commit selected" }));
  await waitFor(() =>
    expect(calls.find((c) => c.url.endsWith("/commit"))?.body).toEqual({
      reviewId: "review-1",
      paths: ["a.ts"],
      message: "Selected change",
    }),
  );
  expect(screen.queryByRole("button", { name: "Stage hunk 1" })).toBeNull();
  expect(screen.getByRole("button", { name: "Unstage hunk 1" })).toBeTruthy();
});
test("Fetch is explicit and scoped to the current review and HEAD", async () => {
  const calls = fixture();
  await load();
  expect(calls.filter((c) => c.url.endsWith("/fetch"))).toHaveLength(0);
  expect(screen.getByText("https")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fetch origin" }));
  await waitFor(() =>
    expect(calls.find((c) => c.url.endsWith("/fetch"))?.body).toEqual({
      reviewId: "review-1",
      remote: "origin",
      expectedHead: repo.head,
    }),
  );
});
test.each([{ writes: false }, { historical: true }])(
  "readonly capability/history disables all Git mutations and Fetch %j",
  async (options) => {
    const calls = fixture(options);
    await load();
    for (const name of [
      "Stage file",
      "Unstage file",
      "Discard file",
      "Fetch origin",
    ])
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    fireEvent.keyDown(document, { key: "s" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  },
);
test("late discard preview cannot open against a newly selected file", async () => {
  fixture();
  const original = fetch,
    held = deferred();
  vi.stubGlobal("fetch", (url: any, init: any) =>
    String(url).endsWith("/discard-preview")
      ? held.promise
      : original(url, init),
  );
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Discard file" }));
  fireEvent.keyDown(document, { key: "j" });
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "b.ts",
    ),
  );
  held.resolve({
    previewId: "old",
    path: "a.ts",
    operation: "restore-index",
    target: { ...repo, worktreeRoot: repo.root },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("late Git action response cannot refresh or overwrite a newer mode", async () => {
  const calls = fixture();
  const original = fetch,
    held = deferred();
  vi.stubGlobal("fetch", (url: any, init: any) =>
    String(url).endsWith("/git") ? held.promise : original(url, init),
  );
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Stage file" }));
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await screen.findByRole("button", { name: "Unstage hunk 1" });
  const before = calls.filter((c) => c.url.includes("/review?")).length;
  held.resolve({ ok: true, changed: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.filter((c) => c.url.includes("/review?")).length).toBe(before);
  expect(
    (screen.getByLabelText("Review mode") as HTMLSelectElement).value,
  ).toBe("staged");
});
test("no-op and failed actions are truthful and preserve current draft", async () => {
  fixture();
  const original = fetch;
  let fail = false;
  vi.stubGlobal("fetch", (url: any, init: any) =>
    String(url).endsWith("/git")
      ? Promise.resolve(
          response(
            fail
              ? { error: "Finish other Git operation" }
              : { ok: true, changed: false },
            fail ? 400 : 200,
          ),
        )
      : original(url, init),
  );
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "still here" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Stage file" }));
  await screen.findByText(/No index changes/);
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Unstage file" }));
  await screen.findByText("Finish other Git operation");
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("still here");
});

test("discard confirmation remains outside the inert background and blocks navigation shortcuts", async () => {
  const calls = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Discard file" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm discard" });
  await waitFor(() =>
    expect(document.querySelector(".workspace")?.hasAttribute("inert")).toBe(
      true,
    ),
  );
  expect(dialog.closest("[inert]")).toBeNull();
  const before = calls.filter((c) => c.url.includes("/diff?")).length;
  fireEvent.keyDown(document, { key: "j" });
  expect(calls.filter((c) => c.url.includes("/diff?")).length).toBe(before);
  fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.filter((c) => c.url.endsWith("/discard"))).toHaveLength(0);
});
test("manual async refresh retains selected staged paths and commit message", async () => {
  fixture({ mode: "staged" });
  await load();
  fireEvent.click(screen.getByLabelText("Commit a.ts"));
  fireEvent.change(screen.getByLabelText("Commit message"), {
    target: { value: "draft commit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await screen.findByRole("button", { name: "old line 1" });
  expect(
    (screen.getByLabelText("Commit a.ts") as HTMLInputElement).checked,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Commit message") as HTMLTextAreaElement).value,
  ).toBe("draft commit");
});

test("configured Git shortcuts remain suppressed in fields and every confirmation modal", async () => {
  const calls = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
  for (const [label, key] of [
    ["Stage file", "s"],
    ["Discard file", "d"],
    ["Fetch selected remote", "f"],
  ])
    fireEvent.change(screen.getByLabelText(`${label} shortcut`), {
      target: { value: key },
    });
  fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  for (const key of ["s", "d", "f"])
    fireEvent.keyDown(screen.getByLabelText("Comment body"), { key });
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  fireEvent.keyDown(document, { key: "d" });
  await screen.findByRole("dialog", { name: "Confirm discard" });
  fireEvent.keyDown(document, { key: "s" });
  fireEvent.keyDown(document, { key: "f" });
  expect(
    calls.filter(
      (call) => call.url.endsWith("/git") || call.url.endsWith("/fetch"),
    ),
  ).toHaveLength(0);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(document, { key: "s" });
  await waitFor(() =>
    expect(calls.some((call) => call.body?.action === "stage")).toBe(true),
  );
});
test("stale capabilities and remote metadata cannot reenable writes or replace newer metadata", async () => {
  fixture();
  const original = fetch,
    oldCapabilities = deferred(),
    oldRemotes = deferred();
  let capabilities = 0,
    remotes = 0;
  vi.stubGlobal("fetch", (url: any, init: any) => {
    const route = String(url);
    if (route.endsWith("/capabilities")) {
      capabilities++;
      return capabilities <= 2
        ? oldCapabilities.promise
        : Promise.resolve(
            response({
              writesEnabled: false,
              fetchEnabled: false,
              reason: "Current writes disabled",
              hunkStageMode: "working",
              hunkUnstageMode: "staged",
            }),
          );
    }
    if (route.endsWith("/remotes")) {
      remotes++;
      return remotes <= 2
        ? oldRemotes.promise
        : Promise.resolve(
            response({
              remotes: [
                {
                  name: "current",
                  url: "ssh://current.example/repo",
                  transport: "ssh",
                  fetchAvailable: true,
                  reason: null,
                },
              ],
            }),
          );
    }
    return original(url, init);
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await screen.findByText("Current writes disabled");
  oldCapabilities.resolve({ writesEnabled: true, fetchEnabled: true });
  oldRemotes.resolve({
    remotes: [
      {
        name: "old",
        url: "https://old.example/repo",
        transport: "https",
        fetchAvailable: true,
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    screen.getByRole("button", { name: "Stage file" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText("ssh://current.example/repo")).toBeTruthy();
  expect(screen.queryByText("https://old.example/repo")).toBeNull();
});
test("700px drawer behavior retains the current project and visible unavailable roots across themes", async () => {
  fixture();
  const original = fetch;
  vi.stubGlobal("innerWidth", 700);
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    if (String(url) === "/api/repositories")
      return response({
        repositories: [repo],
        selectedRepositoryId: repo.id,
        base: "HEAD",
        mode: "working",
        errors: [
          {
            root: "/unmounted/project",
            error: "Registered root is unavailable",
          },
        ],
      });
    return original(url, init);
  });
  await load();
  expect(screen.getByRole("alert").textContent).toContain("/unmounted/project");
  fireEvent.click(screen.getByRole("button", { name: /Agent Review/ }));
  expect(document.querySelector(".app")?.classList.contains("rail-open")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Notes" }));
  expect(document.querySelector(".app")?.classList.contains("panel-open")).toBe(
    true,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), {
    target: { value: "dark" },
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(screen.getByText("/unmounted/project")).toBeTruthy();
});

const otherRepo = {
  ...repo,
  id: "other",
  root: "/fixture/other",
  projectId: "other-project",
};
function multipleRepositories() {
  const calls = fixture(),
    original = fetch;
  vi.stubGlobal("fetch", (url: any, init: any = {}) => {
    const route = String(url);
    if (route === "/api/repositories" && init.method === "GET")
      return Promise.resolve(
        response({
          repositories: [repo, otherRepo],
          selectedRepositoryId: repo.id,
          base: "HEAD",
          mode: "working",
          navigationRevision: 0,
          contexts: {},
        }),
      );
    if (route === "/api/directory-roots")
      return Promise.resolve(
        response({
          roots: [{ id: "fixture", label: "Fixture", path: "/fixture" }],
        }),
      );
    if (route.startsWith("/api/directory-listing?")) {
      const relativePath =
        new URL(route, "http://fixture").searchParams.get("path") || "";
      return Promise.resolve(
        response({
          rootId: "fixture",
          relativePath,
          path: relativePath ? `/fixture/${relativePath}` : "/fixture",
          entries: relativePath ? [] : [{ name: "new", relativePath: "new" }],
          nextCursor: null,
          truncated: false,
        }),
      );
    }
    return original(url, init);
  });
  return calls;
}
async function selectNewFolder() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Open folder new" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Current folder").textContent).toBe(
      "/fixture/new",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select this folder" }));
}

test("a folder registration failure preserves the selected review and unsaved draft through cancellation", async () => {
  multipleRepositories();
  const original = fetch;
  vi.stubGlobal("fetch", (url: any, init: any = {}) =>
    String(url) === "/api/repositories" && init.method === "POST"
      ? Promise.resolve(
          response({ error: "Selected folder is not a Git repository" }, 400),
        )
      : original(url, init),
  );
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Keep this draft through a failed folder selection" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
  await selectNewFolder();
  await screen.findByText("Selected folder is not a Git repository");
  expect(screen.getByLabelText("Current folder").textContent).toBe(
    "/fixture/new",
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
  );
  expect(
    (screen.getByLabelText("Registered worktree") as HTMLSelectElement).value,
  ).toBe("repo");
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Keep this draft through a failed folder selection");
});

test("dismissed older registration retains inventory without replacing a newer root or its draft", async () => {
  multipleRepositories();
  const original = fetch,
    held = deferred();
  let registered = false;
  vi.stubGlobal("fetch", (url: any, init: any = {}) => {
    if (String(url) === "/api/repositories" && init.method === "POST") {
      registered = true;
      return held.promise;
    }
    return original(url, init);
  });
  await load();
  fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
  await selectNewFolder();
  await waitFor(() => expect(registered).toBe(true));
  fireEvent.keyDown(screen.getByRole("dialog"), {
    key: "Escape",
  });
  fireEvent.change(screen.getByLabelText("Registered worktree"), {
    target: { value: otherRepo.id },
  });
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Newer root draft" },
  });
  held.resolve({
    ...repo,
    id: "new",
    root: "/fixture/new",
    projectId: "new-project",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    (screen.getByLabelText("Registered worktree") as HTMLSelectElement).value,
  ).toBe(otherRepo.id);
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Newer root draft");
  expect(
    screen.getByRole("option", { name: /new · \/fixture\/new/ }),
  ).toBeTruthy();
});
test("an older selection error cannot replace the newer selected-root state or its draft", async () => {
  multipleRepositories();
  const original = fetch,
    held = deferred();
  let requested = false;
  vi.stubGlobal("fetch", (url: any, init: any = {}) => {
    if (String(url).endsWith(`/other/selection`)) {
      requested = true;
      return held.promise;
    }
    return original(url, init);
  });
  await load();
  fireEvent.change(screen.getByLabelText("Registered worktree"), {
    target: { value: otherRepo.id },
  });
  await waitFor(() => expect(requested).toBe(true));
  fireEvent.change(screen.getByLabelText("Registered worktree"), {
    target: { value: repo.id },
  });
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Latest draft" },
  });
  held.resolve({ error: "Old selection failed" }, 400);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Old selection failed")).toBeNull();
  expect(
    (screen.getByLabelText("Registered worktree") as HTMLSelectElement).value,
  ).toBe(repo.id);
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Latest draft");
});

test.each([false, true])(
  "dismissed registration failure stays silent after newer navigation, unmount=%s",
  async (unmount) => {
    multipleRepositories();
    const original = fetch,
      held = deferred();
    vi.stubGlobal("fetch", (url: any, init: any = {}) =>
      String(url) === "/api/repositories" && init.method === "POST"
        ? held.promise
        : original(url, init),
    );
    await load();
    fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
    await selectNewFolder();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
    });
    fireEvent.change(screen.getByLabelText("Registered worktree"), {
      target: { value: otherRepo.id },
    });
    await screen.findByRole("button", { name: "old line 1" });
    if (unmount) cleanup();
    held.resolve({ error: "Old registration failed" }, 400);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Old registration failed")).toBeNull();
  },
);
