import { afterEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  rename,
  chmod,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ReviewStore } from "../packages/review/src/store.js";
import { registerRepository } from "../apps/server/src/registry.js";
import { RepositoryQueue } from "../packages/git/src/mutations.js";
import {
  nativeFetchTransport,
  type FetchTransport,
} from "../packages/git/src/remotes.js";
import { SyncService } from "../apps/server/src/sync-service.js";
import { installSyncRoutes } from "../apps/server/src/routes/sync.js";
const roots: string[] = [],
  stores: ReviewStore[] = [],
  apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  stores.splice(0).forEach((s) => s.close());
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
async function fixture(conflict = false) {
  const home = await mkdtemp(join(tmpdir(), "review-owned-sync-"));
  roots.push(home);
  const root = join(home, "work"),
    donor = join(home, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
    }).trimEnd();
  git("config", "user.name", "Sync Fixture");
  git("config", "user.email", "sync@example.test");
  await writeFile(join(root, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "incoming");
  await writeFile(join(root, conflict ? "a.txt" : "remote.txt"), "remote\n");
  git("add", ".");
  git("commit", "-qm", "incoming");
  const incoming = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", "-q", root, donor]);
  git("switch", "-q", "main");
  if (conflict) {
    await writeFile(join(root, "a.txt"), "local\n");
    git("commit", "-qam", "local");
  }
  git("remote", "add", "origin", "https://example.test/owned.git");
  const repo = await registerRepository(root),
    repositories = new Map([[repo.id, repo]]),
    store = new ReviewStore(join(home, "state"));
  stores.push(store);
  let now = Date.now(),
    calls = 0;
  const transport: FetchTransport = async (command, args, options) => {
    calls++;
    const fixed = [...args];
    fixed.splice(fixed.indexOf("-C"), 0, "-c", "protocol.file.allow=always");
    fixed[fixed.length - 2] = donor;
    await nativeFetchTransport(command, fixed, options);
  };
  const service = new SyncService(repositories, store, {
    queue: new RepositoryQueue(),
    enableWrites: true,
    fetchTransport: transport,
    now: () => now,
  });
  return {
    home,
    root,
    donor,
    repo,
    repositories,
    store,
    git,
    base,
    incoming,
    transport,
    service,
    calls: () => calls,
    advance: (ms: number) => (now += ms),
  };
}

test("freshness fetches missing or older than five minutes before exact pull preview", async () => {
  const f = await fixture();
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  expect(f.calls()).toBe(1);
  expect(p).toMatchObject({
    localBranch: "refs/heads/main",
    localHead: f.base,
    comparisonHead: f.incoming,
    operation: "merge",
  });
  await f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming");
  expect(f.calls()).toBe(1);
  f.advance(300001);
  await f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming");
  expect(f.calls()).toBe(2);
  await expect(f.service.confirmPull(f.repo.id, p.previewId)).rejects.toThrow(
    /preview|expired/i,
  );
});

test("confirmed pull merges selected tracking branch into actual local checkout", async () => {
  const f = await fixture();
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  const result = await f.service.confirmPull(f.repo.id, p.previewId);
  expect(result.outcome).toBe("merged");
  expect(f.git("branch", "--show-current")).toBe("main");
  expect(f.git("rev-parse", "HEAD")).toBe(f.incoming);
  expect(await readFile(join(f.root, "remote.txt"), "utf8")).toBe("remote\n");
});

test("dirty pull is blocked with useful choices and never stashes or changes local work", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "unsaved\n");
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/commit.*stash.*discard/i);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("unsaved\n");
  expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  expect(f.git("stash", "list")).toBe("");
});

test("stale pull preview refuses external edits, ref motion and config changes", async () => {
  const f = await fixture();
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  await writeFile(join(f.root, "a.txt"), "external\n");
  await expect(f.service.confirmPull(f.repo.id, p.previewId)).rejects.toThrow(
    /changed|stale/i,
  );
  expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  f.git("restore", "a.txt");
  const p2 = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  f.git("update-ref", "refs/remotes/origin/incoming", f.base);
  await expect(f.service.confirmPull(f.repo.id, p2.previewId)).rejects.toThrow(
    /changed|stale/i,
  );
  const p3 = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  f.git("config", "remote.origin.url", "https://changed.example.test/repo");
  await expect(f.service.confirmPull(f.repo.id, p3.previewId)).rejects.toThrow(
    /changed|stale/i,
  );
});

test("refresh independently reads unmerged index and MERGE_HEAD across external edit then git add", async () => {
  const f = await fixture(true);
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  expect((await f.service.confirmPull(f.repo.id, p.previewId)).outcome).toBe(
    "conflicts",
  );
  expect((await f.service.status(f.repo.id)).merge).toMatchObject({
    pending: true,
    conflicts: ["a.txt"],
    canContinue: false,
  });
  await writeFile(join(f.root, "a.txt"), "resolved outside app\n");
  expect((await f.service.status(f.repo.id)).merge).toMatchObject({
    pending: true,
    conflicts: ["a.txt"],
    canContinue: false,
  });
  await expect(f.service.mergePreview(f.repo.id, "continue")).rejects.toThrow(
    /stage|unresolved/i,
  );
  f.git("add", "a.txt");
  expect((await f.service.status(f.repo.id)).merge).toMatchObject({
    pending: true,
    conflicts: [],
    canContinue: true,
  });
  const continuation = await f.service.mergePreview(f.repo.id, "continue");
  expect(
    (await f.service.confirmMerge(f.repo.id, continuation.previewId)).outcome,
  ).toBe("continued");
  expect((await f.service.status(f.repo.id)).merge.pending).toBe(false);
  expect(
    f.git("rev-list", "--parents", "-n", "1", "HEAD").split(" "),
  ).toHaveLength(3);
});

test("continue and abort confirmations are stale-safe and one-use", async () => {
  const f = await fixture(true);
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  await f.service.confirmPull(f.repo.id, p.previewId);
  const abort = await f.service.mergePreview(f.repo.id, "abort");
  await writeFile(join(f.root, "a.txt"), "external resolution\n");
  await expect(
    f.service.confirmMerge(f.repo.id, abort.previewId),
  ).rejects.toThrow(/changed|stale/i);
  expect((await f.service.status(f.repo.id)).merge.pending).toBe(true);
  const fresh = await f.service.mergePreview(f.repo.id, "abort");
  const result = await f.service.confirmMerge(f.repo.id, fresh.previewId);
  expect(result.outcome).toBe("aborted");
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("local\n");
  await expect(
    f.service.confirmMerge(f.repo.id, fresh.previewId),
  ).rejects.toThrow(/preview/i);
});

test("fetch all refreshes every eligible configured remote and persists success without touching checkout", async () => {
  const f = await fixture();
  f.git("remote", "add", "backup", "ssh://git@example.test/owned.git");
  f.git("remote", "add", "unsupported", f.donor);
  const before = await readFile(join(f.repo.gitDir, "index"));
  const result = await f.service.fetchAll(f.repo.id);
  expect(result.ok).toBe(true);
  expect(f.calls()).toBe(2);
  expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  expect(await readFile(join(f.repo.gitDir, "index"))).toEqual(before);
  const restarted = new SyncService(f.repositories, f.store, {
    queue: new RepositoryQueue(),
    enableWrites: true,
    fetchTransport: f.transport,
  });
  expect(
    (await restarted.status(f.repo.id)).remotes
      .filter((r) => r.eligible)
      .every((r) => !!r.lastSuccessAt),
  ).toBe(true);
});

test("scheduler deduplicates commonDir, avoids overlap, skips unavailable roots and backs off failures", async () => {
  const f = await fixture();
  const linked = join(f.home, "linked");
  f.git("worktree", "add", "-qb", "linked", linked);
  const other = await registerRepository(linked);
  f.service.admitRepository(other);
  f.repositories.set(other.id, other);
  let release!: () => void,
    attempts = 0;
  const waiting = new Promise<void>((r) => (release = r));
  const service = new SyncService(f.repositories, f.store, {
    queue: new RepositoryQueue(),
    enableWrites: true,
    now: () => 0,
    fetchTransport: async () => {
      attempts++;
      await waiting;
      throw new Error("secret");
    },
  });
  const first = service.tick();
  await new Promise((r) => setTimeout(r, 150));
  const second = service.tick();
  release();
  await Promise.all([first, second]);
  expect(attempts).toBe(1);
  await service.tick();
  expect(attempts).toBe(1);
  expect((await service.status(f.repo.id)).remotes[0].lastError).not.toContain(
    "secret",
  );
  await rename(f.root, f.root + "-away");
  const good = await fixture();
  service.admitRepository(good.repo);
  f.repositories.set(good.repo.id, good.repo);
  await service.tick();
  expect(attempts).toBe(2);
  expect((await service.status(f.repo.id)).available).toBe(false);
});

test("auto fetch settings and configured default remote persist; unknown remote is rejected", async () => {
  const f = await fixture();
  expect(f.service.settings().autoFetchEnabled).toBe(true);
  f.service.setSettings(false);
  await f.service.setGitSettings(f.repo.id, "origin");
  const restored = new SyncService(f.repositories, f.store, {
    queue: new RepositoryQueue(),
    enableWrites: true,
  });
  expect(restored.settings().autoFetchEnabled).toBe(false);
  expect(restored.gitSettings(f.repo.id)).toEqual({ defaultRemote: "origin" });
  await expect(restored.setGitSettings(f.repo.id, "invented")).rejects.toThrow(
    /configured/i,
  );
  restored.setSettings(true);
});

test("noninteractive transport disables prompt helpers and SSH interaction", async () => {
  const f = await fixture();
  let captured: any;
  const service = new SyncService(f.repositories, f.store, {
    queue: new RepositoryQueue(),
    enableWrites: true,
    fetchTransport: async (_c, args, options) => {
      captured = { args, options };
    },
  });
  await service.fetchAll(f.repo.id);
  expect(captured.options.env).toMatchObject({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  });
  expect(captured.options.env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  expect(captured.args).toContain("credential.interactive=false");
});

test("merge custom drivers, unsafe metadata and symlink worktree escapes fail closed", async () => {
  const f = await fixture();
  f.git("config", "merge.evil.driver", "touch /tmp/not-allowed");
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/custom|driver/i);
  f.git("config", "--unset", "merge.evil.driver");
  await symlink(join(f.home, "outside"), join(f.repo.gitDir, "ORIG_HEAD"));
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/unsafe|alias/i);
});

test("routes allow sync before review context, require confirmations, validate settings, and honor read-only", async () => {
  const f = await fixture();
  const app = Fastify();
  apps.push(app);
  installSyncRoutes(app, f.repositories, {} as any, f.store, {
    queue: new RepositoryQueue(),
    enableWrites: false,
    fetchTransport: f.transport,
  });
  expect(
    (await app.inject({ url: `/api/repositories/${f.repo.id}/sync` }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/repositories/${f.repo.id}/fetch-all`,
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/repositories/${f.repo.id}/pull`,
        payload: { previewId: "x" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/sync-settings",
        payload: { autoFetchEnabled: false, intervalMs: 1 },
      })
    ).statusCode,
  ).toBe(400);
});

test("changed remote configuration invalidates freshness and fetches selected recipient again", async () => {
  const f = await fixture();
  await f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming");
  expect(f.calls()).toBe(1);
  f.git("config", "remote.origin.url", "https://new.example.test/owned.git");
  await f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming");
  expect(f.calls()).toBe(2);
});

test("unknown shell credential helpers are refused before automatic or manual synchronized transport", async () => {
  const f = await fixture();
  f.git("config", "credential.helper", "!echo secret; unexpected-dialog");
  const result = await f.service.fetchAll(f.repo.id);
  expect(result.ok).toBe(false);
  expect(f.calls()).toBe(0);
  expect(result.sync.remotes[0].lastError).toMatch(/helper|interactive/i);
});

test("scheduler is lifecycle-managed and closed ticks cannot enter asynchronous fetch or write closed store", async () => {
  const f = await fixture();
  let callback!: () => void,
    removed = false;
  const service = new SyncService(f.repositories, f.store, {
    queue: new RepositoryQueue(),
    enableWrites: true,
    fetchTransport: f.transport,
    setInterval: ((fn: () => void, ms: number) => {
      expect(ms).toBe(300000);
      callback = fn;
      return { unref() {} } as any;
    }) as any,
    clearInterval: (() => {
      removed = true;
    }) as any,
  });
  service.start();
  service.start();
  const running = service.tick();
  await service.close();
  expect(removed).toBe(true);
  const completed = f.calls();
  const afterClose = vi.spyOn(f.store.db, "prepare");
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  await running;
  await service.tick();
  expect(f.calls()).toBe(completed);
  expect(afterClose).not.toHaveBeenCalled();
});

test("abort preview checks staged resolution and later external edits before touching files", async () => {
  const f = await fixture(true);
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  await f.service.confirmPull(f.repo.id, p.previewId);
  await writeFile(join(f.root, "a.txt"), "resolved\n");
  f.git("add", "a.txt");
  const next = await f.service.mergePreview(f.repo.id, "continue");
  await writeFile(join(f.root, "a.txt"), "late external edit\n");
  await expect(
    f.service.confirmMerge(f.repo.id, next.previewId),
  ).rejects.toThrow(/changed|stale/i);
  expect((await f.service.status(f.repo.id)).merge.pending).toBe(true);
});

test("simultaneous scheduler ticks do not enqueue duplicate common-directory fetches", async () => {
  const f = await fixture();
  await Promise.all([f.service.tick(), f.service.tick()]);
  expect(f.calls()).toBe(1);
});

test("merge refuses shared append aliases before preview", async () => {
  const f = await fixture();
  const outside = join(f.home, "outside-log");
  await writeFile(outside, "untouched\n");
  await symlink(outside, join(f.repo.gitDir, "logs", "ORIG_HEAD"));
  f.git("config", "core.logAllRefUpdates", "always");
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/unsafe|alias/i);
  expect(await readFile(outside, "utf8")).toBe("untouched\n");
});

test("merge leaves conflicts unresolved even when Git rerere has a remembered staged resolution", async () => {
  const f = await fixture(true);
  await f.service.fetchAll(f.repo.id);
  f.git("config", "rerere.enabled", "true");
  f.git("config", "rerere.autoupdate", "true");
  try {
    f.git("merge", "--no-edit", "refs/remotes/origin/incoming");
  } catch {}
  await writeFile(join(f.root, "a.txt"), "remembered resolution\n");
  f.git("rerere");
  f.git("merge", "--abort");
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  await f.service.confirmPull(f.repo.id, p.previewId);
  expect((await f.service.status(f.repo.id)).merge.conflicts).toEqual([
    "a.txt",
  ]);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toContain("<<<<<<<");
});

test("branch-specific automatic conflict strategies require using Git explicitly", async () => {
  const f = await fixture(true);
  f.git("config", "branch.main.mergeOptions", "-Xtheirs");
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/merge.*option|strategy/i);
});

test("beforeTick revalidates explicitly registered availability and is skipped when disabled", async () => {
  const f = await fixture();
  let checks = 0;
  const service = new SyncService(f.repositories, f.store, {
    enableWrites: true,
    fetchTransport: f.transport,
    beforeTick: async () => {
      checks++;
    },
  });
  await service.tick();
  expect(checks).toBe(1);
  service.setSettings(false);
  await service.tick();
  expect(checks).toBe(1);
  await service.close();
});

test("shutdown waits for an in-flight registration revalidation and skips fetching after close", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r)),
    waiting = new Promise<void>((r) => (release = r));
  const service = new SyncService(f.repositories, f.store, {
    enableWrites: true,
    fetchTransport: f.transport,
    beforeTick: async () => {
      entered();
      await waiting;
    },
  });
  const tick = service.tick();
  await enteredPromise;
  let finished = false;
  const closing = service.close().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await Promise.all([tick, closing]);
  expect(f.calls()).toBe(0);
});

test("noninteractive SSH safety options precede configured overrides and custom commands fail closed", async () => {
  const f = await fixture();
  f.git("config", "core.sshCommand", "ssh -o BatchMode=no");
  let captured: any;
  const service = new SyncService(f.repositories, f.store, {
    enableWrites: true,
    fetchTransport: async (_c, _a, options) => {
      captured = options.env;
    },
  });
  await service.fetchAll(f.repo.id);
  expect(captured.GIT_SSH_COMMAND).toMatch(
    /^ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o BatchMode=no$/,
  );
  f.git("config", "core.sshCommand", 'sh -c "unexpected-dialog"');
  const result = await service.fetchAll(f.repo.id);
  expect(result.ok).toBe(false);
  expect(result.sync.remotes[0].lastError).toMatch(/SSH|command/i);
});

test("unrelated ignored symlinks do not block a pull that cannot overwrite them", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ".gitignore"), "ignored-link\n");
  f.git("add", ".gitignore");
  f.git("commit", "-qm", "ignore generated artifact");
  await symlink(join(f.home, "artifact"), join(f.root, "ignored-link"));
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  expect((await f.service.confirmPull(f.repo.id, p.previewId)).outcome).toBe(
    "merged",
  );
});

test("legacy Fetch and synchronization share a common-directory transport lock", async () => {
  const f = await fixture();
  const linked = join(f.home, "linked-fetch");
  f.git("worktree", "add", "-qb", "linked-fetch", linked);
  const other = await registerRepository(linked);
  let active = 0,
    max = 0,
    entered!: () => void,
    release!: () => void;
  const firstEntered = new Promise<void>((r) => (entered = r)),
    waiting = new Promise<void>((r) => (release = r));
  const transport: FetchTransport = async () => {
    active++;
    max = Math.max(max, active);
    entered();
    await waiting;
    active--;
  };
  const { fetchRemote } = await import("../packages/git/src/remotes.js");
  const first = fetchRemote(f.repo, "origin", f.repo.head, transport),
    second = fetchRemote(other, "origin", other.head, transport);
  await firstEntered;
  await new Promise((r) => setTimeout(r, 100));
  release();
  await Promise.all([first, second]);
  expect(max).toBe(1);
});

test("raw dirty bytes hidden by Git stat cache block pull without implicit saves", async () => {
  const f = await fixture();
  const { utimes } = await import("node:fs/promises");
  const path = join(f.root, "a.txt"),
    old = new Date(Date.now() - 60000);
  old.setMilliseconds(0);
  await utimes(path, old, old);
  f.git("update-index", "--refresh");
  f.git("config", "core.trustctime", "false");
  f.git("config", "core.checkStat", "minimal");
  await writeFile(path, "edit\n");
  await utimes(path, old, old);
  expect(f.git("status", "--porcelain")).toBe("");
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/local work|dirty/i);
  expect(await readFile(path, "utf8")).toBe("edit\n");
});

test("a replacement clone at the same canonical paths cannot inherit synchronization authorization", async () => {
  const f = await fixture();
  await rename(f.root, f.root + "-original");
  execFileSync("git", ["clone", "-q", "-b", "main", f.donor, f.root]);
  f.git("config", "remote.origin.url", "https://example.test/owned.git");
  expect((await f.service.status(f.repo.id)).available).toBe(false);
  await f.service.tick();
  expect(f.calls()).toBe(0);
  await expect(f.service.fetchAll(f.repo.id)).rejects.toThrow(
    /identity|changed|unavailable/i,
  );
});

test("remote recipient changed during transport cannot create a successful pull preview", async () => {
  const f = await fixture();
  let calls = 0;
  const service = new SyncService(f.repositories, f.store, {
    enableWrites: true,
    fetchTransport: async (c, a, o) => {
      calls++;
      await f.transport(c, a, o);
      f.git(
        "config",
        "remote.origin.url",
        "https://changed-during-fetch.example.test/repo",
      );
    },
  });
  await expect(
    service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/Fetch|changed/i);
  expect(calls).toBe(1);
  expect((await service.status(f.repo.id)).remotes[0].lastSuccessAt).toBeNull();
  expect(f.git("rev-parse", "HEAD")).toBe(f.base);
});

test("new effective info attributes after preview cannot auto-resolve a conflict", async () => {
  const f = await fixture(true);
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/incoming",
  );
  await writeFile(
    join(f.repo.commonDir, "info", "attributes"),
    "a.txt merge=union\n",
  );
  await expect(f.service.confirmPull(f.repo.id, p.previewId)).rejects.toThrow(
    /attribute|changed/i,
  );
  expect(f.git("rev-parse", "HEAD")).toBe(f.repo.head);
  expect((await f.service.status(f.repo.id)).merge.pending).toBe(false);
});

test("configured global merge attributes are refused before preview", async () => {
  const f = await fixture(true);
  const attrs = join(f.home, "global-attributes");
  await writeFile(attrs, "a.txt merge=union\n");
  f.git("config", "core.attributesFile", attrs);
  await expect(
    f.service.pullPreview(f.repo.id, "refs/remotes/origin/incoming"),
  ).rejects.toThrow(/attribute/i);
});

test("Fetch honors configured tracking aliases before Pull certifies their freshness", async () => {
  const f = await fixture();
  f.git(
    "config",
    "remote.origin.fetch",
    "+refs/heads/incoming:refs/remotes/origin/review",
  );
  f.git("update-ref", "refs/remotes/origin/review", f.base);
  const p = await f.service.pullPreview(
    f.repo.id,
    "refs/remotes/origin/review",
  );
  expect(p.comparisonHead).toBe(f.incoming);
  await f.service.confirmPull(f.repo.id, p.previewId);
  expect(f.git("rev-parse", "HEAD")).toBe(f.incoming);
});

test("worktree-specific remotes are explicitly ineligible rather than silently skipped by project scheduling", async () => {
  const f = await fixture();
  const linked = join(f.home, "worktree-config");
  f.git("worktree", "add", "-qb", "worktree-config", linked);
  f.git("config", "extensions.worktreeConfig", "true");
  execFileSync("git", [
    "-C",
    linked,
    "config",
    "--worktree",
    "remote.private.url",
    "https://worktree.example.test/repo",
  ]);
  execFileSync("git", [
    "-C",
    linked,
    "config",
    "--worktree",
    "remote.private.fetch",
    "+refs/heads/*:refs/remotes/private/*",
  ]);
  const other = await registerRepository(linked);
  f.service.admitRepository(other);
  f.repositories.set(other.id, other);
  const status = await f.service.status(other.id);
  expect(status.remotes.find((r) => r.name === "private")).toMatchObject({
    eligible: false,
    reason: expect.stringMatching(/worktree-specific/i),
  });
  await f.service.tick();
  expect(f.calls()).toBe(1);
});

test("explicit dynamic admission captures identity before first sync and refuses later clone replacement", async () => {
  const f = await fixture();
  const dynamic = new Map<string, typeof f.repo>();
  const service = new SyncService(dynamic, f.store, {
    enableWrites: true,
    fetchTransport: f.transport,
  });
  const admitted = await registerRepository(f.root);
  dynamic.set(admitted.id, admitted);
  service.admitRepository(admitted);
  await rename(f.root, f.root + "-before-dynamic-clone");
  execFileSync("git", [
    "clone",
    "--no-hardlinks",
    "-q",
    "-b",
    "main",
    f.donor,
    f.root,
  ]);
  f.git("config", "remote.origin.url", "https://example.test/owned.git");
  service.admitRepository(admitted);
  expect((await service.status(admitted.id)).available).toBe(false);
  await service.tick();
  expect(f.calls()).toBe(0);
});

test("new repository objects cannot acquire physical authorization by first status or tick", async () => {
  const f = await fixture();
  const dynamic = new Map<string, typeof f.repo>();
  const service = new SyncService(dynamic, f.store, {
    enableWrites: true,
    fetchTransport: f.transport,
  });
  dynamic.set(f.repo.id, f.repo);
  expect((await service.status(f.repo.id)).available).toBe(false);
  await service.tick();
  expect(f.calls()).toBe(0);
  service.admitRepository(f.repo);
  expect((await service.status(f.repo.id)).available).toBe(true);
});

test("saved admission identity closes the gap between validated restore and later service construction", async () => {
  const f = await fixture();
  const { lstatSync } = await import("node:fs");
  const identity = JSON.stringify(
    [f.repo.root, f.repo.gitDir, f.repo.commonDir].map((path) => {
      const s = lstatSync(path, { bigint: true });
      return [String(s.dev), String(s.ino)];
    }),
  );
  await rename(f.root, f.root + "-before-delayed-service");
  execFileSync("git", [
    "clone",
    "--no-hardlinks",
    "-q",
    "-b",
    "main",
    f.donor,
    f.root,
  ]);
  f.git("config", "remote.origin.url", "https://example.test/owned.git");
  const service = new SyncService(f.repositories, f.store, {
    enableWrites: true,
    fetchTransport: f.transport,
    admissionIdentity: () => identity,
  });
  expect((await service.status(f.repo.id)).available).toBe(false);
  await service.tick();
  expect(f.calls()).toBe(0);
  await expect(service.fetchAll(f.repo.id)).rejects.toThrow(
    /identity|changed|admitted/i,
  );
});
