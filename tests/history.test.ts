import { test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../packages/review/src/store.js";
import { AgentManager } from "../packages/agents/src/manager.js";
import { saveReviewHistory } from "../packages/review/src/history.js";
import { startAdapter } from "../packages/agents/src/adapters.js";
import { registerRepository } from "../apps/server/src/registry.js";
import { getReview, getHistoricalReview } from "../packages/git/src/review.js";
import type { ReviewHistoryEntry } from "../packages/shared/src/index.js";
test("metadata history cap retains active run direct scoped lookup and interrupted restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const store = new ReviewStore(dir);
  try {
    const factory = () => {
      throw Error("must not spawn");
    };
    const manager = new AgentManager(store, factory);
    const run = {
      id: "active",
      adapter: "claude",
      status: "running",
      target: { repositoryId: "repo" },
      profile: {},
      commentIds: [],
      createdAt: "now",
      finishedAt: null,
      exitCode: null,
      error: null,
    };
    store.db
      .prepare("INSERT INTO agent_runs VALUES(?,?,?)")
      .run(run.id, "repo", JSON.stringify(run));
    for (let i = 0; i < 1005; i++) {
      store.db
        .prepare("INSERT INTO agent_runs VALUES(?,?,?)")
        .run(
          "r" + i,
          "repo",
          JSON.stringify({ ...run, id: "r" + i, status: "completed" }),
        );
      saveReviewHistory(store.db, {
        id: "o" + i,
        repositoryId: "repo",
        fingerprint: "hash",
        base: "base",
        mergeBase: "base",
        head: "head",
        branch: "main",
        mode: "working",
        files: [],
      });
    }
    expect(manager.history("repo")).toHaveLength(1000);
    expect(manager.get("repo", "active").status).toBe("running");
    expect(() => manager.get("other", "active")).toThrow("Unknown run");
    const recovered = new AgentManager(store, factory);
    expect(recovered.get("repo", "active").status).toBe("interrupted");
    expect(recovered.history("repo")).toHaveLength(1000);
    expect(store.history("repo")).toHaveLength(1000);
    expect(store.history("repo")[0]!.historicalContent).toBe("unavailable");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("OpenCode UTF8 argv bound rejects before factory and accepts exact limit", () => {
  let calls = 0;
  const factory = () => {
    calls++;
    throw Error("fixture");
  };
  expect(() =>
    startAdapter("opencode", factory, "/fixture", "é".repeat(32769)),
  ).toThrow("64KiB");
  expect(calls).toBe(0);
  expect(() =>
    startAdapter("opencode", factory, "/fixture", "é".repeat(32768)),
  ).toThrow("fixture");
  expect(calls).toBe(1);
});
test("adapter execution refuses runtime values outside the executable allowlist before spawn", () => {
  let calls = 0;
  const factory = () => {
    calls++;
    throw Error("must not spawn");
  };
  expect(() =>
    startAdapter("untrusted-provider" as any, factory, "/fixture", "prompt"),
  ).toThrow("Unsupported adapter");
  expect(calls).toBe(0);
});
test("missing local binaries report unavailable without guessed success", async () => {
  const { adapterAvailability } =
    await import("../packages/agents/src/adapters.js");
  const previous = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent-fixture-path";
    for (const id of ["claude", "opencode"] as const) {
      const a = await adapterAvailability(id);
      expect(a.available).toBe(false);
      expect(a.version).toBe(null);
      expect(a.error).toContain("unavailable");
    }
  } finally {
    process.env.PATH = previous;
  }
});

test("historic branch metadata reopens gitlink changes without fetching foreign submodule objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "historic-gitlink-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(root, "a.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git(
      "update-index",
      "--add",
      "--cacheinfo",
      "160000," + "a".repeat(40) + ",submodule",
    );
    git("commit", "-qm", "gitlink");
    const repo = await registerRepository(root);
    const review = await getReview(repo, base, "branch");
    const entry: ReviewHistoryEntry = {
      ...review,
      fileCount: 1,
      acceptedAt: "now",
      historicalContent: "git-objects-only",
    };
    const reopened = await getHistoricalReview(repo, entry);
    expect(reopened.historical).toBe(true);
    expect(reopened.files[0]!.kind).toBe("submodule");
    expect(reopened.files[0]!.newOid).toBe("a".repeat(40));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historic branch needs retained HEAD and merge-base, while immutable base metadata survives base-only object removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "historic-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(root, "a.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const mergeBase = git("rev-parse", "HEAD");
    git("checkout", "-qb", "comparison-base");
    writeFileSync(join(root, "base-only.txt"), "base only\n");
    git("add", ".");
    git("commit", "-qm", "base only");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "review", mergeBase);
    writeFileSync(join(root, "a.txt"), "reviewed\n");
    git("add", ".");
    git("commit", "-qm", "reviewed");
    const repo = await registerRepository(root);
    const review = await getReview(repo, base, "branch");
    const entry: ReviewHistoryEntry = {
      ...review,
      fileCount: 1,
      acceptedAt: "now",
      historicalContent: "git-objects-only",
    };
    unlinkSync(join(root, ".git", "objects", base.slice(0, 2), base.slice(2)));
    const reopened = await getHistoricalReview(repo, entry);
    expect(reopened.base).toBe(base);
    expect(reopened.mergeBase).toBe(mergeBase);
    expect(reopened.fingerprint).toBe(review.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active fixture run remains scoped and stoppable after capped history pruning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "active-history-"));
  const store = new ReviewStore(dir);
  const manager = new AgentManager(store, (_command, _args, options) =>
    spawn(
      process.execPath,
      ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      options,
    ),
  );
  const context: any = {
    target: { repositoryId: "repo", worktreeRoot: dir },
    profile: { effective: { locator: "fixture", digest: "digest" } },
    comments: [],
  };
  const input: any = { adapter: "codex", reviewId: "fixture", commentIds: [] };
  try {
    const active = await manager.start(
      input,
      async () => context,
      "fixture skill",
    );
    for (let i = 0; i < 1005; i++)
      store.db
        .prepare("INSERT INTO agent_runs VALUES(?,?,?)")
        .run(
          "done" + i,
          "repo",
          JSON.stringify({ ...active, id: "done" + i, status: "completed" }),
        );
    const newer = await manager.start(
      input,
      async () => context,
      "fixture skill",
    );
    expect(manager.history("repo")).toHaveLength(1000);
    expect(manager.history("repo").some((run) => run.id === active.id)).toBe(
      false,
    );
    expect(manager.get("repo", active.id).status).toBe("running");
    expect(() => manager.stop("other", active.id)).toThrow("Unknown run");
    const events: any[] = [];
    const unsubscribe = manager.subscribe("repo", active.id, (event) =>
      events.push(event),
    );
    expect(events[0].run.id).toBe(active.id);
    expect(manager.stop("repo", active.id).status).toBe("stopped");
    expect(manager.stop("repo", newer.id).status).toBe("stopped");
    unsubscribe();
  } finally {
    await manager.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepted review history is metadata-only and immutable for its scoped identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "metadata-history-"));
  const store = new ReviewStore(dir);
  try {
    const observation: any = {
      id: "accepted",
      repositoryId: "repo",
      fingerprint: "digest",
      base: "base",
      mergeBase: "merge",
      head: "head",
      branch: "branch",
      mode: "branch",
      files: [{ path: "private-path", source: "PRIVATE_SOURCE" }],
      prompt: "PRIVATE_PROMPT",
      rawLog: "PRIVATE_LOG",
    };
    saveReviewHistory(store.db, observation);
    const entry = store.history("repo")[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      [
        "id",
        "repositoryId",
        "fingerprint",
        "base",
        "mergeBase",
        "head",
        "branch",
        "mode",
        "acceptedAt",
        "fileCount",
        "historicalContent",
      ].sort(),
    );
    expect(JSON.stringify(entry)).not.toMatch(/PRIVATE_|private-path/);
    saveReviewHistory(store.db, { ...observation, head: "changed", files: [] });
    expect(store.history("repo")).toEqual([entry]);
    expect(store.history("other")).toEqual([]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
