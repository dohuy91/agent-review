import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { ReviewStore } from "../packages/review/src/store.js";
import { AgentManager } from "../packages/agents/src/manager.js";
import { RepositoryQueue } from "../packages/git/src/mutations.js";
import { installAgentRoutes } from "../apps/server/src/routes/agents.js";
const roots: string[] = [];
const stores: ReviewStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "agent-operation-"));
  roots.push(dir);
  const result = new ReviewStore(dir);
  stores.push(result);
  return result;
}
function child() {
  const result: any = new EventEmitter();
  result.stdin = new PassThrough();
  result.stdout = new PassThrough();
  result.stderr = new PassThrough();
  result.kill = vi.fn(() => true);
  return result;
}
test("an agent remains active after Stop until its owned process actually exits", async () => {
  const fake = child(),
    manager = new AgentManager(await store(), () => fake);
  try {
    const context: any = {
      target: { repositoryId: "repo", worktreeRoot: "/fixture" },
      profile: { effective: { locator: "fixture", digest: "digest" } },
      comments: [],
    };
    expect(manager.hasActive("repo")).toBe(false);
    const run = await manager.start(
      { adapter: "codex", reviewId: "fixture", commentIds: [] } as any,
      async () => context,
      "fixture",
    );
    expect(manager.hasActive("repo")).toBe(true);
    expect(manager.hasActive("other")).toBe(false);
    manager.stop("repo", run.id);
    expect(manager.get("repo", run.id).status).toBe("stopped");
    expect(manager.hasActive("repo")).toBe(true);
    fake.emit("close", null);
    expect(manager.hasActive("repo")).toBe(false);
  } finally {
    fake.emit("close", null);
    await manager.close();
  }
});
test("agent validation and launch wait behind the supplied repository operation queue", async () => {
  const app = Fastify(),
    queue = new RepositoryQueue(),
    validate = vi.fn(async () => {
      throw Object.assign(new Error("Fixture stale"), { statusCode: 409 });
    });
  let release!: () => void;
  const held = queue.run(
    "repo",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const queued = vi.spyOn(queue, "run");
  installAgentRoutes(
    app,
    new Map([["repo", { id: "repo" } as any]]),
    { getObservation: validate } as any,
    await store(),
    { queue, skillRoots: [], processFactory: () => child() },
  );
  try {
    await app.ready();
    const pending = app.inject({
      method: "POST",
      url: "/api/repositories/repo/agents",
      payload: {
        adapter: "codex",
        reviewId: "review",
        commentIds: ["comment"],
        expected: {},
      },
    });
    const response = pending.then((result) => result);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    expect(validate).not.toHaveBeenCalled();
    release();
    await held;
    expect((await response).statusCode).toBe(409);
    expect(validate).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await held;
    await app.close();
  }
});
