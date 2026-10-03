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
function fixture(
  initialTarget?: string,
  switchState: "clean" | "dirty" | "occupied" = "clean",
) {
  const calls: { url: string; body: any }[] = [];
  let remoteVersion = 0;
  let checkoutRef = "refs/heads/main";
  let switchTarget = "";
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url);
    calls.push({ url: route, body: opts.body ? JSON.parse(opts.body) : null });
    let data: any = {};
    if (route === "/api/repositories")
      data = {
        repositories: [
          {
            id: "repo",
            root: "/fixture",
            projectId: "project",
            branch: checkoutRef,
            head: "checkout",
          },
        ],
        selectedRepositoryId: "repo",
        base: "refs/remotes/origin/main",
        mode: initialTarget ? "branch" : "working",
        target: initialTarget,
        contexts: {
          repo: {
            base: "refs/remotes/origin/main",
            mode: initialTarget ? "branch" : "working",
            target: initialTarget,
          },
        },
      };
    else if (route.endsWith("/branches"))
      data = {
        branches: [
          "refs/heads/main",
          "refs/heads/feature",
          "refs/heads/sibling",
        ],
        localBranches: [
          "refs/heads/main",
          "refs/heads/feature",
          "refs/heads/sibling",
        ],
        remoteBranches: [
          "refs/remotes/origin/main",
          "refs/remotes/upstream/release",
          ...(remoteVersion ? ["refs/remotes/origin/added"] : []),
        ],
        current: checkoutRef,
      };
    else if (route.endsWith("/branch-switch-preview")) {
      switchTarget = JSON.parse(opts.body).targetRef;
      data = {
        previewId: "preview",
        repositoryId: "repo",
        reviewId: "checkout",
        expiresAt: "later",
        from: { branch: checkoutRef, head: "checkout" },
        target: { branch: switchTarget, head: "next" },
        status: switchState,
        dirty: {
          staged: ["b.ts"],
          unstaged: ["a.ts"],
          untracked: ["draft.txt"],
        },
        ...(switchState === "occupied"
          ? {
              occupied: {
                root: "/other/worktree",
                repositoryId: "registered-other",
                branch: switchTarget,
                head: "next",
              },
            }
          : {}),
      };
    } else if (route.endsWith("/branch-switch")) {
      const request = JSON.parse(opts.body);
      checkoutRef = switchTarget;
      data = {
        ok: true,
        outcome: "switched",
        branch: checkoutRef,
        head: "next",
        ...(request.strategy === "stash"
          ? {
              stash: {
                oid: "stash-saved",
                sourceBranch: "refs/heads/main",
                message: "saved local work",
              },
            }
          : {}),
      };
    } else if (route.includes("/review?")) {
      const query = new URL(route, "http://fixture").searchParams;
      const target = query.get("target");
      const id = target || "checkout";
      data = {
        id,
        mode: query.get("mode"),
        base: query.get("base"),
        baseRef: query.get("base"),
        targetRef: target || undefined,
        branch: target || checkoutRef,
        head: target ? "compared" : "checkout",
        worktree: { branch: checkoutRef, head: "checkout" },
        executionEligible: !target || target === checkoutRef,
        files: [
          {
            path: "a.ts",
            status: "M",
            kind: "text",
            oldMode: "100644",
            newMode: "100644",
          },
        ],
      };
    } else if (route.includes("/diff?")) {
      const query = new URL(route, "http://fixture").searchParams;
      data = {
        reviewId: query.get("reviewId"),
        path: query.get("path"),
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [
              {
                type: "context",
                text: "const value = 1",
                oldLine: 1,
                newLine: 1,
              },
            ],
          },
        ],
      };
    } else if (route.includes("/comments")) data = { comments: [] };
    else if (route.includes("/profiles"))
      data = {
        profiles: {},
        revision: 0,
        effective: { locator: "skill://fixture", digest: "a".repeat(64) },
      };
    else if (route.includes("/reviewed")) data = { files: [] };
    else if (route.endsWith("/agents"))
      data = {
        writesEnabled: true,
        agents: [
          {
            id: "codex",
            available: true,
            provider: { label: "Fixture provider" },
          },
        ],
      };
    else if (route.endsWith("/skills"))
      data = {
        skills: [
          {
            locator: "skill://fixture",
            digest: "a".repeat(64),
            name: "Fixture skill",
          },
        ],
      };
    else if (route.endsWith("/history")) data = { reviews: [], runs: [] };
    else if (route.endsWith("/git/status"))
      data = { writesEnabled: true, files: [], remotes: [] };
    else if (route.endsWith("/remotes")) data = { remotes: [] };
    return { ok: true, status: 200, json: async () => data };
  });
  return { calls, addRemote: () => remoteVersion++ };
}
async function load() {
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
}
function openRefs(label: string) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input);
  return input;
}
function refOptions(label: string) {
  return within(
    screen.getByRole("listbox", { name: `${label} options` }),
  ).queryAllByRole("option");
}
function chooseRef(label: string, ref: string) {
  openRefs(label);
  fireEvent.click(
    refOptions(label).find(
      (option) => option.getAttribute("data-ref") === ref,
    )!,
  );
}

test("distinct local-target and remote-base selectors enumerate full refs while repository selection stays separate", async () => {
  const f = fixture();
  await load();
  const local = openRefs("Local target branch");
  expect(
    refOptions("Local target branch").map((o) => o.getAttribute("data-ref")),
  ).toEqual(["refs/heads/main", "refs/heads/feature", "refs/heads/sibling"]);
  fireEvent.keyDown(local, { key: "Escape" });
  const remote = openRefs("Remote base branch");
  expect(
    refOptions("Remote base branch").map((o) => o.getAttribute("data-ref")),
  ).toContain("refs/remotes/upstream/release");
  expect(
    (screen.getByLabelText("Registered worktree") as HTMLSelectElement).value,
  ).toBe("repo");
  fireEvent.keyDown(remote, { key: "Escape" });
  chooseRef("Local target branch", "refs/heads/feature");
  await waitFor(() =>
    expect(f.calls.some((call) => call.url.endsWith("/branch-switch"))).toBe(
      true,
    ),
  );
  await waitFor(() =>
    expect((local as HTMLInputElement).value).toBe("refs/heads/feature"),
  );
  expect(
    screen.queryByRole("status", { name: "Comparison target status" }),
  ).toBeNull();
  expect(
    (screen.getByLabelText("Review mode") as HTMLSelectElement).value,
  ).toBe("branch");
  chooseRef("Remote base branch", "refs/remotes/upstream/release");
  await waitFor(() =>
    expect(
      f.calls.some(
        (call) =>
          call.url.includes("base=refs%2Fremotes%2Fupstream%2Frelease") &&
          !call.url.includes("target="),
      ),
    ).toBe(true),
  );
});

test("advanced commit/local bases remain explicit and choosing checkout clears saved target", async () => {
  const f = fixture("refs/heads/feature");
  await load();
  expect(
    (screen.getByLabelText("Local target branch") as HTMLInputElement).value,
  ).toBe("refs/heads/feature");
  fireEvent.click(screen.getByRole("button", { name: "Advanced base" }));
  fireEvent.change(screen.getByLabelText("Base reference"), {
    target: { value: "HEAD~2" },
  });
  await waitFor(() =>
    expect(
      f.calls.some(
        (c) =>
          c.url.includes("base=HEAD%7E2") &&
          c.url.includes("target=refs%2Fheads%2Ffeature"),
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Local target branch") as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  chooseRef("Local target branch", "refs/heads/main");
  await waitFor(() =>
    expect(
      f.calls.some(
        (c) =>
          c.url.includes("/review?") &&
          c.url.includes("base=HEAD%7E2") &&
          !c.url.includes("target="),
      ),
    ).toBe(true),
  );
  expect(
    (
      within(screen.getByLabelText("Review mode")).getByRole("option", {
        name: "Working tree",
      }) as HTMLOptionElement
    ).disabled,
  ).toBe(false);
});

test("manual refresh updates remote-tracking options and keeps an unsaved current-target comment", async () => {
  const f = fixture();
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Do not move this draft" },
  });
  f.addRemote();
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  openRefs("Remote base branch");
  await waitFor(() =>
    expect(
      screen.getByRole("option", {
        name: "origin/added",
      }),
    ).toBeTruthy(),
  );
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Do not move this draft");
});

test("late comparison response cannot replace a newer remote base or its target-bound draft", async () => {
  const f = fixture("refs/heads/feature");
  const original = fetch;
  let release!: () => void,
    held = false;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const response = await original(url, opts);
    if (
      String(url).includes("/review?") &&
      String(url).includes("base=refs%2Fremotes%2Fupstream%2Frelease")
    ) {
      held = true;
      return new Promise((resolve) => (release = () => resolve(response)));
    }
    return response;
  });
  await load();
  chooseRef("Remote base branch", "refs/remotes/upstream/release");
  await waitFor(() => expect(held).toBe(true));
  expect(screen.queryByRole("button", { name: "old line 1" })).toBeNull();
  chooseRef("Remote base branch", "refs/remotes/origin/main");
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Feature-specific draft" },
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    (screen.getByLabelText("Remote base branch") as HTMLInputElement).value,
  ).toBe("refs/remotes/origin/main");
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Feature-specific draft");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  await waitFor(() =>
    expect(f.calls.find((call) => call.body?.body)?.body).toMatchObject({
      reviewId: "refs/heads/feature",
      path: "a.ts",
      side: "old",
    }),
  );
});

test("branch search filters locally and only an exact keyboard option changes the comparison", async () => {
  const f = fixture();
  await load();
  const before = f.calls.filter((c) => c.url.includes("/review?")).length;
  const local = openRefs("Local target branch");
  fireEvent.change(local, { target: { value: "EA" } });
  expect(
    refOptions("Local target branch").map((o) => o.getAttribute("data-ref")),
  ).toEqual(["refs/heads/feature"]);
  expect(f.calls.filter((c) => c.url.includes("/review?")).length).toBe(before);
  expect(local.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(local, { key: "ArrowDown" });
  expect(
    document.getElementById(local.getAttribute("aria-activedescendant")!)
      ?.textContent,
  ).toContain("feature");
  fireEvent.keyDown(local, { key: "Enter" });
  await waitFor(() =>
    expect(f.calls.some((c) => c.url.endsWith("/branch-switch"))).toBe(true),
  );
  await waitFor(() =>
    expect((local as HTMLInputElement).value).toBe("refs/heads/feature"),
  );
  expect((local as HTMLInputElement).value).toBe("refs/heads/feature");
  expect(local.getAttribute("title")).toBe("refs/heads/feature");
  expect(local.getAttribute("aria-expanded")).toBe("false");

  const remote = openRefs("Remote base branch");
  fireEvent.change(remote, { target: { value: "not-a-ref" } });
  expect(refOptions("Remote base branch")).toHaveLength(0);
  const committed = f.calls.filter((c) => c.url.includes("/review?")).length;
  fireEvent.keyDown(remote, { key: "Enter" });
  fireEvent.keyDown(remote, { key: "Escape" });
  expect((remote as HTMLInputElement).value).toBe("refs/remotes/origin/main");
  expect(f.calls.filter((c) => c.url.includes("/review?")).length).toBe(
    committed,
  );
});

test("committing a local option previews and switches checkout while search alone cannot write", async () => {
  const f = fixture();
  await load();
  const local = openRefs("Local target branch");
  fireEvent.change(local, { target: { value: "feature" } });
  expect(
    f.calls.some((call) => call.url.endsWith("/branch-switch-preview")),
  ).toBe(false);
  fireEvent.keyDown(local, { key: "Enter" });
  await waitFor(() =>
    expect(
      f.calls.find((call) => call.url.endsWith("/branch-switch"))?.body,
    ).toEqual({ previewId: "preview", strategy: "clean" }),
  );
  await waitFor(() =>
    expect((local as HTMLInputElement).value).toBe("refs/heads/feature"),
  );
  expect(
    f.calls.find((call) => call.url.endsWith("/branch-switch-preview"))?.body,
  ).toEqual({ reviewId: "checkout", targetRef: "refs/heads/feature" });
  expect(
    screen.queryByRole("status", { name: "Comparison target status" }),
  ).toBeNull();
});

test("dirty branch cancel preserves the current draft and confirmed stash reports its retained recovery ID", async () => {
  const f = fixture(undefined, "dirty");
  await load();
  fireEvent.click(screen.getByRole("button", { name: "old line 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "keep before branch decision" },
  });
  chooseRef("Local target branch", "refs/heads/feature");
  const dialog = await screen.findByRole("dialog", {
    name: "Switch local branch",
  });
  expect(within(dialog).getByText("draft.txt")).toBeTruthy();
  expect(f.calls.some((call) => call.url.endsWith("/branch-switch"))).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("keep before branch decision");
  expect(
    (screen.getByLabelText("Local target branch") as HTMLInputElement).value,
  ).toBe("refs/heads/main");
  chooseRef("Local target branch", "refs/heads/feature");
  fireEvent.click(
    await screen.findByRole("button", { name: "Stash & switch" }),
  );
  await waitFor(() =>
    expect(
      f.calls.find((call) => call.url.endsWith("/branch-switch"))?.body,
    ).toEqual({ previewId: "preview", strategy: "stash", confirmed: true }),
  );
  expect(await screen.findByText(/stash-saved/)).toBeTruthy();
});

test("dismissed delayed branch preview cannot switch checkout", async () => {
  const f = fixture();
  const original = fetch;
  let release!: () => void;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const response = await original(url, opts);
    if (String(url).endsWith("/branch-switch-preview"))
      return new Promise((resolve) => {
        release = () => resolve(response);
      });
    return response;
  });
  await load();
  chooseRef("Local target branch", "refs/heads/feature");
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.calls.some((call) => call.url.endsWith("/branch-switch"))).toBe(
    false,
  );
  expect(
    (screen.getByLabelText("Local target branch") as HTMLInputElement).value,
  ).toBe("refs/heads/main");
});

test("commit-and-switch uses selected staged paths and requires a new stash decision for remaining local work", async () => {
  const f = fixture(undefined, "dirty");
  const original = fetch;
  let saved = false;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url),
      payload = opts.body ? JSON.parse(opts.body) : null;
    if (route.endsWith("/branch-switch") && payload.strategy === "commit") {
      f.calls.push({ url: route, body: payload });
      saved = true;
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: "Local work remains",
          outcome: "saved-not-switched",
          reason: "remaining-dirty",
          commit: "saved-commit",
          remainingDirty: {
            staged: [],
            unstaged: ["a.ts"],
            untracked: ["draft.txt"],
          },
        }),
      };
    }
    const response = await original(url, opts);
    if (route.endsWith("/branch-switch-preview") && saved) {
      const result = await response.json();
      return {
        ...response,
        json: async () => ({
          ...result,
          previewId: "fresh-preview",
          dirty: { staged: [], unstaged: ["a.ts"], untracked: ["draft.txt"] },
        }),
      };
    }
    return response;
  });
  await load();
  chooseRef("Local target branch", "refs/heads/feature");
  fireEvent.click(await screen.findByLabelText("Commit staged files"));
  fireEvent.change(screen.getByLabelText("Branch switch commit message"), {
    target: { value: "Save selected staged work" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Commit & switch" }));
  await screen.findByText(/Saved commit: saved-commit/);
  await waitFor(() =>
    expect(
      f.calls.filter((call) => call.url.endsWith("/branch-switch-preview")),
    ).toHaveLength(2),
  );
  expect(
    f.calls.find((call) => call.body?.strategy === "commit")?.body,
  ).toEqual({
    previewId: "preview",
    strategy: "commit",
    confirmed: true,
    commit: { paths: ["b.ts"], message: "Save selected staged work" },
  });
  expect(
    f.calls.filter((call) => call.url.endsWith("/branch-switch")),
  ).toHaveLength(1);
  fireEvent.click(
    await screen.findByRole("button", { name: "Stash & switch" }),
  );
  await waitFor(() =>
    expect(
      f.calls.find((call) => call.body?.strategy === "stash")?.body.previewId,
    ).toBe("fresh-preview"),
  );
});

test("stale branch switch preview requires refresh before a clean retry", async () => {
  const f = fixture(undefined, "dirty");
  const original = fetch;
  let rejected = false;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url);
    if (route.endsWith("/branch-switch") && !rejected) {
      rejected = true;
      f.calls.push({ url: route, body: JSON.parse(opts.body) });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: "Preview expired",
          outcome: "not-switched",
          reason: "stale",
        }),
      };
    }
    const response = await original(url, opts);
    if (route.endsWith("/branch-switch-preview") && rejected) {
      const result = await response.json();
      return {
        ...response,
        json: async () => ({
          ...result,
          status: "clean",
          dirty: { staged: [], unstaged: [], untracked: [] },
        }),
      };
    }
    return response;
  });
  await load();
  chooseRef("Local target branch", "refs/heads/feature");
  fireEvent.click(
    await screen.findByRole("button", { name: "Stash & switch" }),
  );
  await screen.findByRole("alert");
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh branch status" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Switch branch" }));
  await waitFor(() =>
    expect(
      f.calls.filter((call) => call.url.endsWith("/branch-switch")),
    ).toHaveLength(2),
  );
});

test("a successful checkout remains visible when its subsequent comparison cannot be loaded", async () => {
  fixture();
  const original = fetch;
  let switched = false;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) => {
    const route = String(url);
    if (switched && route.includes("/review?"))
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "No common ancestor" }),
      };
    const response = await original(url, opts);
    if (route.endsWith("/branch-switch")) switched = true;
    return response;
  });
  await load();
  chooseRef("Local target branch", "refs/heads/feature");
  await screen.findByText("No common ancestor");
  expect(
    (screen.getByLabelText("Local target branch") as HTMLInputElement).value,
  ).toBe("refs/heads/feature");
  expect(screen.getByText("Switched to refs/heads/feature.")).toBeTruthy();
  expect(screen.getByText("The comparison could not be loaded.")).toBeTruthy();
  expect(screen.queryByText("No changes in this comparison.")).toBeNull();
});

test("a deleted saved comparison target can be cleared to the current checkout without a branch switch", async () => {
  const f = fixture("refs/heads/deleted");
  const original = fetch;
  vi.stubGlobal("fetch", async (url: any, opts: any = {}) =>
    String(url).includes("/review?") &&
    String(url).includes("target=refs%2Fheads%2Fdeleted")
      ? {
          ok: false,
          status: 500,
          json: async () => ({
            error: "Selected local branch no longer exists",
          }),
        }
      : original(url, opts),
  );
  render(<App />);
  await screen.findByText("Selected local branch no longer exists");
  chooseRef("Local target branch", "refs/heads/main");
  await screen.findByRole("button", { name: "old line 1" });
  expect(
    (screen.getByLabelText("Local target branch") as HTMLInputElement).value,
  ).toBe("refs/heads/main");
  expect(
    f.calls.some((call) => call.url.endsWith("/branch-switch-preview")),
  ).toBe(false);
  expect(f.calls.some((call) => call.url.endsWith("/branch-switch"))).toBe(
    false,
  );
});

test("left file navigation and compact skill settings leave only current notes and controls on the right", async () => {
  fixture();
  await load();
  const left = document.getElementById("project-pane")!;
  const right = document.getElementById("details-pane")!;
  expect(within(left).getByLabelText("Registered worktree")).toBeTruthy();
  expect(within(left).getByRole("treeitem", { name: /a.ts/ })).toBeTruthy();
  expect(within(right).queryByRole("treeitem", { name: /a.ts/ })).toBeNull();
  expect(within(right).queryByText("Review history")).toBeNull();
  expect(within(right).queryByText("Fix skill settings")).toBeNull();
  expect(screen.queryByLabelText("Installed skill")).toBeNull();
  expect(within(right).getByText("skill://fixture")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fix profiles" }));
  const dialog = screen.getByRole("dialog");
  expect(
    await within(dialog).findByLabelText("Installed fix skill"),
  ).toBeTruthy();
});
