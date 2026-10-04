import { canonicalMkdtemp as mkdtemp } from "./filesystem-fixtures.js";
import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { test, expect, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { registerRepository } from "../apps/server/src/registry.js";
import { RepositoryWatch } from "../apps/server/src/watch.js";
test("real Git worktree, index and refs debounce; ignored trees and close stay silent", async () => {
  const root = await mkdtemp(join(tmpdir(), "watch-fixture-"));
  let watch: RepositoryWatch | undefined;
  try {
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a]);
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    await writeFile(join(root, "a.txt"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    watch = new RepositoryWatch(await registerRepository(root));
    await watch.ready;
    let events = 0;
    watch.subscribe(() => events++);
    await writeFile(join(root, "a.txt"), "changed");
    git("add", ".");
    git("branch", "fixture");
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toBe(1);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules", "ignored"), "x");
    await writeFile(join(root, ".git", "objects", "ignored"), "x");
    await new Promise((r) => setTimeout(r, 350));
    expect(events).toBe(1);
    await watch.close();
    await writeFile(join(root, "a.txt"), "closed");
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toBe(1);
  } finally {
    await watch?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("index and refs invalidate independently, including linked worktree common refs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watch-linked-"));
  let watch: RepositoryWatch | undefined;
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a]);
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    await writeFile(join(root, "a"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    const linked = join(dir, "linked");
    git("worktree", "add", "-qb", "linked", linked);
    watch = new RepositoryWatch(await registerRepository(linked));
    await watch.ready;
    let count = 0;
    watch.subscribe(() => count++);
    execFileSync("git", [
      "-C",
      linked,
      "update-index",
      "--assume-unchanged",
      "a",
    ]);
    await new Promise((r) => setTimeout(r, 350));
    expect(count).toBe(1);
    git("branch", "external-ref");
    await new Promise((r) => setTimeout(r, 350));
    expect(count).toBe(2);
    await writeFile(join(linked, "a"), "source");
    await new Promise((r) => setTimeout(r, 350));
    expect(count).toBe(3);
  } finally {
    await watch?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("authenticated SSE is metadata-only and preClose ends an active stream", async () => {
  const { createApp } = await import("../apps/server/src/app.js");
  const dir = await mkdtemp(join(tmpdir(), "watch-sse-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a]);
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    await writeFile(join(root, "secret-name"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    app = await createApp({
      port: 7373,
      token: "fixture",
      dataDir: join(dir, "state"),
      repositoryPath: root,
    });
    const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token: "fixture" },
    });
    const cookie = session.headers["set-cookie"]!.toString().split(";")[0];
    const repo = await registerRepository(root);
    expect(
      (
        await app.inject({
          url: `/api/repositories/${repo.id}/events`,
          headers,
        })
      ).statusCode,
    ).toBe(401);
    const stream = app.inject({
      url: `/api/repositories/${repo.id}/events`,
      headers: { ...headers, cookie },
    });
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(join(root, "secret-name"), "new private fixture content");
    await new Promise((r) => setTimeout(r, 400));
    const additional = Array.from({ length: 15 }, () =>
      app!.inject({
        url: `/api/repositories/${repo.id}/events`,
        headers: { ...headers, cookie },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(
      (
        await app.inject({
          url: `/api/repositories/${repo.id}/events`,
          headers: { ...headers, cookie },
        })
      ).statusCode,
    ).toBe(503);
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("close hung")), 1500),
      ),
    ]);
    expect(
      (await Promise.all(additional)).every((r) => r.statusCode === 200),
    ).toBe(true);
    const response = await stream;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: {"type":"invalidate"}');
    expect(response.body).not.toContain("secret-name");
    expect(response.body).not.toContain("private fixture");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close settles readiness even when native discovery never reports ready", async () => {
  const native = new EventEmitter() as FSWatcher;
  native.close = async () => {};
  const spy = vi.spyOn(chokidar, "watch").mockReturnValue(native);
  try {
    const repo = {
      root: "/fixture",
      gitDir: "/fixture/.git",
      commonDir: "/fixture/.git",
    } as any;
    const watch = new RepositoryWatch(repo);
    let settled = false;
    void watch.ready.then(() => (settled = true));
    await watch.close();
    await Promise.resolve();
    expect(settled).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("shutdown settles an SSE request during deterministic delayed native readiness", async () => {
  const { createApp } = await import("../apps/server/src/app.js");
  const dir = await mkdtemp(join(tmpdir(), "watch-pending-"));
  const natives: FSWatcher[] = [];
  let started: () => void = () => {};
  const created = new Promise<void>((r) => (started = r));
  const spy = vi.spyOn(chokidar, "watch").mockImplementation(() => {
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = async () => {};
    natives.push(watcher);
    started();
    return watcher;
  });
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a]);
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    await writeFile(join(root, "a"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    app = await createApp({
      port: 7373,
      token: "fixture",
      dataDir: join(dir, "state"),
      repositoryPath: root,
    });
    const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token: "fixture" },
    });
    const cookie = session.headers["set-cookie"]!.toString().split(";")[0];
    const repo = await registerRepository(root);
    const response = app.inject({
      url: `/api/repositories/${repo.id}/events`,
      headers: { ...headers, cookie },
    });
    await created;
    const closing = app.close();
    const outcome = await Promise.race([
      closing.then(() => "closed"),
      new Promise<string>((r) => setTimeout(() => r("hung"), 300)),
    ]);
    // Unblock the known red implementation so the failing test leaves no server resources.
    if (outcome === "hung") for (const native of natives) native.emit("ready");
    await closing;
    const result = await response;
    expect(outcome).toBe("closed");
    expect(result.statusCode).toBe(503);
  } finally {
    spy.mockRestore();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect cancels a pending readiness request and releases its watcher", async () => {
  const { default: Fastify } = await import("fastify");
  const { installWatchRoutes } =
    await import("../apps/server/src/routes/watch.js");
  const native = new EventEmitter() as FSWatcher;
  let closed = 0;
  native.close = async () => {
    closed++;
  };

  const app = Fastify();
  const repo = {
    id: "fixture",
    root: "/fixture",
    gitDir: "/fixture/.git",
    commonDir: "/fixture/.git",
  } as any;
  let raw: any;
  let started: () => void = () => {};
  const pending = new Promise<void>((r) => (started = r));
  const spy = vi.spyOn(chokidar, "watch").mockImplementation(() => {
    started();
    return native;
  });
  app.addHook("preHandler", async (_req, reply) => {
    raw = reply.raw;
  });
  installWatchRoutes(app, new Map([["fixture", repo]]));
  try {
    const response = app
      .inject({ url: "/api/repositories/fixture/events" })
      .then(
        () => "completed",
        (e) => e.message,
      );
    await pending;
    await Promise.resolve();
    raw.emit("close");
    const result = await Promise.race([
      response,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("disconnect did not settle")), 300),
      ),
    ]);
    expect(result).toBe("response destroyed before completion");
    await vi.waitFor(() => expect(closed).toBe(1));
  } finally {
    await app.close();
    spy.mockRestore();
  }
});
