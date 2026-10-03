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
    "MutationObserver",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
  ])
    vi.stubGlobal(name, name === "window" ? dom.window : dom.window[name]);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}
installDOM();
beforeEach(installDOM);
const { cleanup, fireEvent, render, screen, within } =
  await import("@testing-library/react");
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createApp } from "../apps/server/src/app.js";
import PushActions from "../apps/web/src/components/PushActions.js";
import type { PushTransport } from "../packages/git/src/push.js";
import type {
  Repository,
  ReviewObservation,
} from "../packages/shared/src/index.js";
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(renamedComparison = false) {
  const parent = await mkdtemp(join(tmpdir(), "review-push-ui-"));
  roots.push(parent);
  const root = join(parent, "repo"),
    remote = join(parent, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "diff.autoRefreshIndex=false",
        "-C",
        root,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "a.txt"), "base\n");
  git("add", "a.txt");
  git("commit", "-qm", "Base fixture");
  const base = git("rev-parse", "HEAD");
  execFileSync("git", [
    "clone",
    "--bare",
    "--no-hardlinks",
    "-q",
    root,
    remote,
  ]);
  git("checkout", "-qb", "topic/example");
  await writeFile(join(root, "a.txt"), "topic\n");
  git("commit", "-qam", "Outgoing fixture");
  const target = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  const recipient = "https://push.example.test/fixture.git";
  git("remote", "add", "origin", recipient);
  if (renamedComparison) {
    git(
      "config",
      "remote.origin.fetch",
      "+refs/heads/release:refs/remotes/origin/main",
    );
    execFileSync("git", [
      "--git-dir",
      remote,
      "update-ref",
      "refs/heads/release",
      base,
    ]);
  }
  git("update-ref", "refs/remotes/origin/main", base);
  const calls: string[][] = [];
  const transport: PushTransport = async (command, args, options) => {
    calls.push([...args]);
    const replaced = [...args];
    const index = replaced.indexOf(recipient);
    if (index < 0) throw new Error("Unexpected fixture recipient");
    replaced[index] = remote;
    replaced.splice(
      replaced.indexOf("-C"),
      0,
      "-c",
      "protocol.file.allow=always",
    );
    return new Promise((resolve) =>
      execFile(
        command,
        replaced,
        { ...options, encoding: "buffer" },
        (error, stdout) =>
          resolve({
            code: error ? Number((error as { code?: number }).code ?? 1) : 0,
            stdout: stdout as Buffer,
          }),
      ),
    );
  };
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: join(parent, "state"),
    repositoryPath: root,
    base: "refs/remotes/origin/main",
    mode: "branch",
    pushTransport: transport,
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
  const repository = (
    await app.inject({ url: "/api/repositories", headers: auth })
  ).json().repositories[0] as Repository;
  const review = (
    await app.inject({
      url:
        "/api/repositories/" +
        repository.id +
        "/review?base=refs%2Fremotes%2Forigin%2Fmain&mode=branch&target=refs%2Fheads%2Ftopic%2Fexample",
      headers: auth,
    })
  ).json() as ReviewObservation;
  expect(review.executionEligible).toBe(false);
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    const response = await app.inject({
      method: options.method as "POST",
      url,
      headers: { ...auth, "content-type": "application/json" },
      payload: options.body as string,
    });
    return {
      ok: response.statusCode < 400,
      status: response.statusCode,
      json: async () => response.json(),
    } as Response;
  });
  const onRefresh = vi.fn();
  const remoteMetadata = (
    await app.inject({
      url: `/api/repositories/${repository.id}/remotes`,
      headers: auth,
    })
  ).json();
  render(
    <PushActions
      repository={repository}
      review={review}
      enabled={true}
      remotes={["origin"]}
      comparisonDestinations={remoteMetadata.comparisonDestinations ?? []}
      onRefresh={onRefresh}
      onDialogChange={() => {}}
    />,
  );
  return { root, remote, git, base, target, calls, onRefresh, remoteMetadata };
}

test("real UI confirmation pushes exactly a selected non-worktree branch through the production app routes", async () => {
  const f = await fixture();
  const index = await readFile(join(f.root, ".git/index"));
  expect(f.calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole(
    "dialog",
    { name: "Confirm push" },
    { timeout: 5000 },
  );
  expect(
    within(dialog).getByText("https://push.example.test/fixture.git"),
  ).toBeTruthy();
  expect(within(dialog).getByText("Outgoing fixture")).toBeTruthy();
  expect(f.calls.filter((args) => args.includes("push"))).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm push" }));
  await screen.findByText(/^Pushed /, {}, { timeout: 5000 });
  expect(
    execFileSync(
      "git",
      ["--git-dir", f.remote, "rev-parse", "refs/heads/topic/example"],
      { encoding: "utf8" },
    ).trim(),
  ).toBe(f.target);
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("base\n");
  expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
  expect(f.calls.filter((args) => args.includes("push"))).toHaveLength(1);
  expect(f.onRefresh).toHaveBeenCalledTimes(1);
}, 15000);

test("renamed tracking comparison pushes configured release while remote main stays unchanged", async () => {
  const f = await fixture(true);
  expect(f.remoteMetadata.comparisonDestinations).toContainEqual({
    trackingRef: "refs/remotes/origin/main",
    remote: "origin",
    destinationRef: "refs/heads/release",
  });
  expect(f.calls).toHaveLength(0);
  fireEvent.click(screen.getByLabelText("Push to comparison branch"));
  expect(
    (screen.getByLabelText("Push destination branch") as HTMLInputElement)
      .value,
  ).toBe("refs/heads/release");
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
  expect(within(dialog).getByText("refs/heads/release")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm push" }));
  await screen.findByText(/^Pushed /, {}, { timeout: 5000 });
  const oid = (ref: string) =>
    execFileSync("git", ["--git-dir", f.remote, "rev-parse", ref], {
      encoding: "utf8",
    }).trim();
  expect(oid("refs/heads/release")).toBe(f.target);
  expect(oid("refs/heads/main")).toBe(f.base);
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(f.calls.filter((args) => args.includes("push"))).toHaveLength(1);
}, 15000);

test("a source change after preview prevents transmission and is explained in the UI", async () => {
  const f = await fixture();
  fireEvent.click(screen.getByRole("button", { name: "Preview push" }));
  const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
  await writeFile(join(f.root, "a.txt"), "new uncommitted change\n");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm push" }));
  expect(
    (await screen.findByRole("alert", {}, { timeout: 5000 })).textContent,
  ).toMatch(/changed|stale|refresh/i);
  expect(f.calls.filter((args) => args.includes("push"))).toHaveLength(0);
  expect(f.onRefresh).not.toHaveBeenCalled();
}, 15000);
