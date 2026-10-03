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

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
function fixture() {
  const calls: { url: string; method: string; body: any }[] = [];
  let conflicts = ["src/a.ts"];
  const sync = (id: string) => ({
    repositoryId: id,
    available: true,
    fetching: false,
    writesEnabled: true,
    autoFetchEnabled: true,
    actual: { branch: "refs/heads/feature", head: "abc" },
    remotes: [
      {
        name: "origin",
        eligible: true,
        reason: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        nextAttemptAt: null,
      },
    ],
    merge: {
      pending: true,
      mergeHeads: ["def"],
      conflicts,
      canContinue: !conflicts.length,
      reason: conflicts.length ? "Resolve and stage conflicts" : null,
    },
    error: null,
  });
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url),
      id = route.includes("/other/") ? "other" : "repo";
    calls.push({
      url: route,
      method: opts.method || "GET",
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    let data: any = {};
    if (route === "/api/repositories")
      data = {
        repositories: ["repo", "other"].map((id) => ({
          id,
          root: `/fixture/${id}`,
          projectId: id,
          branch: "refs/heads/feature",
          head: "abc",
        })),
        selectedRepositoryId: "repo",
        base: "refs/remotes/origin/main",
      };
    else if (route.endsWith("/branches"))
      data = {
        localBranches: ["feature"],
        remoteBranches: ["refs/remotes/origin/main"],
        current: "feature",
      };
    else if (route.includes("/review?"))
      data = {
        id: `rev-${id}`,
        repositoryId: id,
        fingerprint: "fingerprint",
        mode: "full",
        branch: "refs/heads/feature",
        head: "abc",
        baseRef: "refs/remotes/origin/main",
        files: ["src/a.ts", "src/b.ts"].map((path) => ({
          path,
          status: "M",
          kind: "text",
          addedLines: 1,
          deletedLines: 1,
        })),
      };
    else if (route.includes("/diff?"))
      data = {
        reviewId: `rev-${id}`,
        path: new URL(route, "http://fixture").searchParams.get("path"),
        hunks: [
          {
            oldStart: 1,
            oldCount: 2,
            newStart: 1,
            newCount: 2,
            lines: [
              { type: "context", text: "const a = 1", oldLine: 1, newLine: 1 },
              { type: "context", text: "const b = 2", oldLine: 2, newLine: 2 },
            ],
          },
        ],
      };
    else if (route.includes("/comments")) data = { comments: [] };
    else if (route.includes("/reviewed")) data = { files: [] };
    else if (route.includes("/profiles")) data = { profiles: {}, revision: 0 };
    else if (route.endsWith("/capabilities"))
      data = { writesEnabled: true, fetchEnabled: true };
    else if (route.endsWith("/remotes"))
      data = {
        remotes: [{ name: "origin", fetchAvailable: true }],
        comparisonDestinations: [
          {
            trackingRef: "refs/remotes/origin/main",
            remote: "origin",
            destinationRef: "refs/heads/main",
          },
        ],
      };
    else if (route.endsWith("/sync") || route.endsWith("/fetch-all"))
      data = route.endsWith("/sync") ? sync(id) : { ok: true, sync: sync(id) };
    else if (route.endsWith("/sync-settings"))
      data = { autoFetchEnabled: true, intervalMs: 300000 };
    else if (route.endsWith("/git-settings"))
      data = { defaultRemote: "origin" };
    else if (route.endsWith("/agents"))
      data = { agents: [], writesEnabled: true };
    else if (route.endsWith("/skills")) data = { skills: [] };
    else if (route.endsWith("/project-settings"))
      data = {
        repositoryId: id,
        projectId: id,
        revision: 0,
        settings: {
          startingFolder: `/fixture/${id}`,
          adapter: "codex",
          skill: null,
        },
      };
    return { ok: true, status: 200, json: async () => data };
  });
  return {
    calls,
    resolveExternally() {
      conflicts = [];
    },
  };
}
async function load() {
  render(<App />);
  await screen.findByRole("button", { name: "new line 1" });
}

test("approved workspace puts projects and ordered actions above a comments-only rail", async () => {
  fixture();
  await load();
  const tabs = screen.getByRole("tablist", { name: "Projects" });
  expect(
    within(tabs)
      .getByRole("tab", { name: "repo" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(within(tabs).getByRole("tab", { name: "other" })).toBeTruthy();
  expect(
    within(tabs).getByRole("button", { name: "Open repository" }),
  ).toBeTruthy();
  const toolbar = document.querySelector(".review-toolbar")!;
  const controls = [...toolbar.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") || button.textContent?.trim(),
  );
  expect(controls.indexOf("Pull")).toBeLessThan(controls.indexOf("Push"));
  expect(controls.indexOf("Push")).toBeLessThan(
    controls.indexOf("Fix with Agent"),
  );
  expect(controls.indexOf("Fix with Agent")).toBeLessThan(
    controls.indexOf("Project settings"),
  );
  const refresh = screen.getByRole("button", { name: "Refresh review" });
  expect(refresh.nextElementSibling?.className).toBe("view-toggle");
  const rail = document.querySelector(".aux") as HTMLElement;
  expect(within(rail).queryByText("Git actions")).toBeNull();
  expect(within(rail).queryByText("Fix with agent")).toBeNull();
  expect(screen.getByRole("button", { name: "File actions" })).toBeTruthy();
});

test("selecting a line immediately focuses inline comment and keeps populated original range", async () => {
  fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "new line 1" }));
  const body = screen.getByLabelText("Comment body") as HTMLTextAreaElement;
  expect(screen.getByTestId("inline-comment-composer").contains(body)).toBe(
    true,
  );
  expect(document.activeElement).toBe(body);
  fireEvent.change(body, { target: { value: "Pinned note" } });
  fireEvent.click(screen.getByRole("button", { name: "new line 2" }));
  expect(
    screen.getByTestId("inline-comment-composer").getAttribute("data-line"),
  ).toBe("1");
  expect(body.value).toBe("Pinned note");
});

test("file and project navigation preserve a draft without replaying it against a different target", async () => {
  const f = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "new line 1" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Project A draft" },
  });
  fireEvent.click(
    screen.getByRole("treeitem", { name: /src\/b.ts, Modified/ }),
  );
  await waitFor(() =>
    expect(document.querySelector(".file-title")?.textContent).toContain(
      "src/b.ts",
    ),
  );
  expect(screen.queryByDisplayValue("Project A draft")).toBeNull();
  fireEvent.click(
    screen.getByRole("treeitem", { name: /src\/a.ts, Modified/ }),
  );
  await screen.findByDisplayValue("Project A draft");
  fireEvent.click(screen.getByRole("tab", { name: "other" }));
  await waitFor(() =>
    expect(
      screen.getByRole("tab", { name: "other" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(screen.queryByDisplayValue("Project A draft")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "repo" }));
  await screen.findByDisplayValue("Project A draft");
  expect(
    f.calls.some(
      (call) => call.method === "POST" && call.url.endsWith("/comments"),
    ),
  ).toBe(false);
});

test("Refresh re-reads external staging and pending merge independently of diff markers", async () => {
  const f = fixture();
  await load();
  await screen.findByText(/1 file needs resolution/);
  expect(
    (
      screen.getByRole("button", {
        name: "Continue merge",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const before = f.calls.filter((call) => call.url.endsWith("/sync")).length;
  f.resolveExternally();
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Continue merge",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(screen.getByText(/Merge paused/)).toBeTruthy();
  expect(
    f.calls.filter((call) => call.url.endsWith("/sync")).length,
  ).toBeGreaterThan(before);
});
