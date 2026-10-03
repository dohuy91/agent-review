// @vitest-environment node
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:7373",
  pretendToBeVisual: true,
});
function installDOM() {
  for (const name of [
    "window",
    "Window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "Node",
    "Range",
    "MutationObserver",
    "localStorage",
    "location",
    "history",
    "KeyboardEvent",
    "MouseEvent",
    "Event",
    "CustomEvent",
  ])
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}
installDOM();
const { cleanup, configure, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
configure({ asyncUtilTimeout: 8000 });
beforeEach(installDOM);
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../apps/server/src/app.js";
import App from "../apps/web/src/App.js";
import * as reviewModule from "../packages/git/src/review.js";
const dirs: string[] = [],
  apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const app of apps.splice(0)) await app.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture(mode: "working" | "staged") {
  const root = await mkdtemp(join(tmpdir(), "review-ui-owned-")),
    state = await mkdtemp(join(tmpdir(), "review-ui-owned-state-"));
  dirs.push(root, state);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trimEnd();
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const original = Array.from(
    { length: 24 },
    (_, index) => `const line${index + 1} = ${index + 1};\n`,
  ).join("");
  await writeFile(join(root, "a.ts"), original);
  await writeFile(join(root, "b.ts"), "base b\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const changed = original
    .replace("const line2 = 2;", "const line2 = 200;")
    .replace("const line22 = 22;", "const line22 = 2200;");
  await writeFile(join(root, "a.ts"), changed);
  await writeFile(join(root, "b.ts"), "staged b\n");
  git("add", "b.ts");
  if (mode === "staged") {
    git("add", "a.ts");
    await writeFile(join(root, "a.ts"), changed + "// unstaged\n");
  }
  git("remote", "add", "origin", "https://example.test/fixture.git");
  let fetches = 0;
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: state,
    repositoryPath: root,
    mode,
    skillRoots: [],
    fetchTransport: async () => {
      fetches++;
    },
    agentAvailability: async () => ({
      id: "codex",
      available: false,
      version: null,
      error: "Fixture only",
    }),
    adapterAvailability: async (adapter) => ({
      id: adapter,
      available: false,
      version: null,
      error: "Fixture only",
    }),
  });
  apps.push(app);
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const session = await app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "fixture" },
  });
  const auth = {
    ...headers,
    cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
  };
  const actions: { url: string; status: number; result: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    const result = await app.inject({
      method: init.method || "GET",
      url: String(url),
      headers: { ...auth, ...init.headers },
      ...(init.body ? { payload: JSON.parse(init.body) } : {}),
    });
    if (init.method === "POST")
      actions.push({
        url: String(url),
        status: result.statusCode,
        result: result.json(),
      });
    return {
      ok: result.statusCode < 400,
      status: result.statusCode,
      json: async () => result.json(),
    } as Response;
  });
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  await screen.findByText("https://example.test/fixture.git");
  return {
    root,
    state,
    app,
    auth,
    getRepositories: async () =>
      (await app.inject({ url: "/api/repositories", headers: auth })).json(),
    git,
    original,
    changed,
    fetches: () => fetches,
    actions,
  };
}
test("owned real Git fixture flows through React→authenticated HTTP hunk stage/unstage and controlled Fetch", async () => {
  const f = await fixture("working");
  const head = f.git("rev-parse", "HEAD"),
    bytes = await readFile(join(f.root, "a.ts"));
  fireEvent.click(screen.getByRole("button", { name: "Stage hunk 1" }));
  await waitFor(() => expect(f.git("show", ":a.ts")).toContain("line2 = 200"));
  expect(f.git("show", ":a.ts")).not.toContain("line22 = 2200");
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await screen.findByRole("button", { name: "Unstage hunk 1" });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Unstage hunk 1" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Unstage hunk 1" }));
  await waitFor(() =>
    expect(f.git("show", ":a.ts")).toBe(f.original.trimEnd()),
  );
  expect(f.git("show", ":b.ts")).toBe("staged b");
  expect(await readFile(join(f.root, "a.ts"))).toEqual(bytes);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "working" },
  });
  await screen.findByRole("button", { name: "old line 1" });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Fetch origin" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Fetch origin" }));
  await waitFor(() => expect(f.fetches()).toBe(1));
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(f.root, "a.ts"))).toEqual(bytes);
}, 20000);
test("owned staged fixture confirms discard then commits only checked index bytes with unrelated bytes retained", async () => {
  const f = await fixture("staged");
  fireEvent.click(screen.getByRole("button", { name: "Discard file" }));
  await screen.findByRole("dialog", { name: "Confirm discard" });
  expect(await readFile(join(f.root, "a.ts"), "utf8")).toContain("unstaged");
  fireEvent.click(screen.getByRole("button", { name: "Confirm discard" }));
  await waitFor(async () =>
    expect(await readFile(join(f.root, "a.ts"), "utf8")).toBe(f.changed),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(screen.getByLabelText("Commit a.ts").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  const index = await readFile(join(f.root, ".git", "index")),
    workA = await readFile(join(f.root, "a.ts")),
    workB = await readFile(join(f.root, "b.ts"));
  fireEvent.click(screen.getByLabelText("Commit a.ts"));
  fireEvent.change(screen.getByLabelText("Commit message"), {
    target: { value: "Only a" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Commit selected" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Commit selected" }));
  await waitFor(
    () =>
      expect(
        f.actions.find((action) => action.url.endsWith("/commit")),
      ).toMatchObject({ status: 200 }),
    { timeout: 8000 },
  );
  await waitFor(() => expect(f.git("log", "-1", "--format=%s")).toBe("Only a"));
  expect(f.git("show", "--format=", "--name-only", "HEAD")).toBe("a.ts");
  expect(await readFile(join(f.root, ".git", "index"))).toEqual(index);
  expect(await readFile(join(f.root, "a.ts"))).toEqual(workA);
  expect(await readFile(join(f.root, "b.ts"))).toEqual(workB);
  expect(f.git("diff", "--cached", "--name-only")).toBe("b.ts");
}, 20000);

test("React reload preserves the accepted selected-root base/mode and the same context remains after server restart", async () => {
  const f = await fixture("working");
  fireEvent.change(screen.getByLabelText("Base reference"), {
    target: { value: "main" },
  });
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await waitFor(async () =>
    expect(await f.getRepositories()).toMatchObject({
      base: "main",
      mode: "staged",
    }),
  );
  cleanup();
  render(<App />);
  await screen.findByTestId("diff");
  expect(
    (screen.getByLabelText("Base reference") as HTMLInputElement).value,
  ).toBe("main");
  expect(
    (screen.getByLabelText("Review mode") as HTMLSelectElement).value,
  ).toBe("staged");
  await waitFor(async () =>
    expect(await f.getRepositories()).toMatchObject({
      base: "main",
      mode: "staged",
    }),
  );
  cleanup();
  await f.app.close();
  const restarted = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: f.state,
    skillRoots: [],
    agentAvailability: async () => ({
      id: "codex",
      available: false,
      version: null,
      error: "Fixture only",
    }),
    adapterAvailability: async (adapter) => ({
      id: adapter,
      available: false,
      version: null,
      error: "Fixture only",
    }),
  });
  apps.push(restarted);
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" },
    login = await restarted.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token: "fixture" },
    });
  const result = await restarted.inject({
    url: "/api/repositories",
    headers: {
      ...headers,
      cookie: login.headers["set-cookie"]!.toString().split(";")[0]!,
    },
  });
  expect(result.json()).toMatchObject({ base: "main", mode: "staged" });
}, 25000);

test("network-reordered React selection requests preserve the latest displayed root, draft and durable restart choice", async () => {
  const f = await fixture("working"),
    otherRoot = await mkdtemp(join(tmpdir(), "review-ui-other-"));
  dirs.push(otherRoot);
  execFileSync("git", ["init", "-q", "--initial-branch=main", otherRoot]);
  execFileSync("git", [
    "-C",
    otherRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  ]);
  const first = await f.getRepositories(),
    registration = await f.app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: {
        ...f.auth,
        "x-review-navigation": String(first.navigationRevision + 1),
      },
      payload: { path: otherRoot },
    }),
    otherId = registration.json().id;
  cleanup();
  render(<App />);
  await screen.findByRole("button", { name: "old line 1" });
  const original = fetch;
  let release!: () => void,
    delayed = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
    if (String(url).endsWith(`/${otherId}/selection`)) {
      delayed = true;
      await held;
    }
    return original(url, init);
  });
  fireEvent.change(screen.getByLabelText("Registered worktree"), {
    target: { value: otherId },
  });
  await waitFor(() => expect(delayed).toBe(true));
  fireEvent.change(screen.getByLabelText("Registered worktree"), {
    target: { value: first.selectedRepositoryId },
  });
  await screen.findByRole("button", { name: "old line 1" });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
  fireEvent.change(screen.getByLabelText("Comment body"), {
    target: { value: "Keep latest root draft" },
  });
  await waitFor(async () =>
    expect((await f.getRepositories()).selectedRepositoryId).toBe(
      first.selectedRepositoryId,
    ),
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(
    (screen.getByLabelText("Registered worktree") as HTMLSelectElement).value,
  ).toBe(first.selectedRepositoryId);
  expect(
    (screen.getByLabelText("Comment body") as HTMLTextAreaElement).value,
  ).toBe("Keep latest root draft");
  expect((await f.getRepositories()).selectedRepositoryId).toBe(
    first.selectedRepositoryId,
  );
  cleanup();
  await f.app.close();
  const restarted = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: f.state,
    skillRoots: [],
  });
  apps.push(restarted);
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" },
    login = await restarted.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token: "fixture" },
    });
  const result = await restarted.inject({
    url: "/api/repositories",
    headers: {
      ...headers,
      cookie: login.headers["set-cookie"]!.toString().split(";")[0]!,
    },
  });
  expect(result.json().selectedRepositoryId).toBe(first.selectedRepositoryId);
}, 25000);

test("dismissed registration reestablishes a pending comparison under its current navigation revision", async () => {
  const f = await fixture("working");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const original = reviewModule.getReview;
  vi.spyOn(reviewModule, "getReview").mockImplementation(async (...args) => {
    if (args[2] === "staged") {
      entered();
      await held;
    }
    return original(...args);
  });
  fireEvent.change(screen.getByLabelText("Review mode"), {
    target: { value: "staged" },
  });
  await started;
  fireEvent.click(screen.getByRole("button", { name: /Open repository/ }));
  fireEvent.keyDown(screen.getByRole("dialog"), {
    key: "Escape",
  });
  release();
  await screen.findByTestId("diff");
  expect(
    (screen.getByLabelText("Review mode") as HTMLSelectElement).value,
  ).toBe("staged");
  await waitFor(async () =>
    expect(await f.getRepositories()).toMatchObject({ mode: "staged" }),
  );
}, 15000);

test("local and remote selectors switch through an explicit retained stash and restore checkout on reload", async () => {
  const f = await fixture("working");
  f.git("stash", "push", "-u", "-m", "fixture-dirty");
  f.git("checkout", "-qb", "feature");
  await writeFile(join(f.root, "feature.ts"), "const feature = true;\n");
  f.git("add", "feature.ts");
  f.git("commit", "-qm", "feature");
  f.git("checkout", "-q", "main");
  f.git("stash", "pop", "--index", "-q");
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const bytes = await readFile(join(f.root, "a.ts"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Local target branch") as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.focus(screen.getByLabelText("Remote base branch"));
  fireEvent.click(screen.getByRole("option", { name: "origin/main" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Local target branch") as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.focus(screen.getByLabelText("Local target branch"));
  fireEvent.click(screen.getByRole("option", { name: "feature" }));
  await waitFor(() => expect(f.actions.find((action) => action.url.endsWith("/branch-switch-preview"))?.result).toMatchObject({status:"dirty"}));
  fireEvent.click(
    await screen.findByRole("button", { name: "Stash & switch" }),
  );
  await screen.findByRole("button", { name: "new line 1" });
  await waitFor(async () =>
    expect(await f.getRepositories()).toMatchObject({
      base: "refs/remotes/origin/main",
      mode: "branch",
      target: null,
    }),
  );
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/feature");
  expect(f.git("status", "--porcelain=v1")).toBe("");
  const switched = f.actions.find((action) =>
    action.url.endsWith("/branch-switch"),
  )!.result as { stash: { oid: string } };
  expect(f.git("show", `${switched.stash.oid}:a.ts`)).toBe(
    bytes.toString().trimEnd(),
  );
  expect(f.git("show", `${switched.stash.oid}^2:b.ts`)).toBe("staged b");
  expect(screen.getByText(new RegExp(switched.stash.oid))).toBeTruthy();
  cleanup();
  render(<App />);
  await screen.findByRole("button", { name: "new line 1" });
  expect(
    (screen.getByLabelText("Local target branch") as HTMLInputElement).value,
  ).toBe("refs/heads/feature");
  expect(
    (screen.getByLabelText("Remote base branch") as HTMLInputElement).value,
  ).toBe("refs/remotes/origin/main");
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/feature");
  expect(f.git("status", "--porcelain=v1")).toBe("");
}, 20000);
