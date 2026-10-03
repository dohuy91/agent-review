import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore } from "../packages/review/src/store.js";
import { AgentManager } from "../packages/agents/src/manager.js";
import { saveReviewHistory } from "../packages/review/src/history.js";
import { startAdapter } from "../packages/agents/src/adapters.js";
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
