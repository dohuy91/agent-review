import { canonicalMkdtemp as mkdtemp } from "./filesystem-fixtures.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  access,
  rename,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { registerRepository } from "../apps/server/src/registry.js";
import { installSecurity } from "../apps/server/src/security.js";
import { installReviewRoutes } from "../apps/server/src/routes/reviews.js";
import { installBranchSwitchRoutes } from "../apps/server/src/routes/branches.js";
import {
  RepositoryQueue,
  writeBranchGit,
  writeGit,
} from "../packages/git/src/mutations.js";

const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  options: {
    writes?: boolean;
    idle?: () => Promise<void>;
    now?: () => number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "review-owned-switch-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
    }).replace(/\n$/, "");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Switch fixture");
  git("config", "user.email", "switch@example.test");
  await writeFile(join(root, "a.txt"), "main\n");
  await writeFile(join(root, "b.txt"), "base b\n");
  git("add", ".");
  git("commit", "-qm", "main");
  const original = git("rev-parse", "HEAD");
  git("switch", "-qc", "other");
  await writeFile(join(root, "a.txt"), "other\n");
  git("commit", "-qam", "other");
  const target = git("rev-parse", "HEAD");
  git("switch", "-q", "main");
  const repo = await registerRepository(root);
  const repositories = new Map([[repo.id, repo]]);
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  apps.push(app);
  await app.register(cookie);
  installSecurity(app, 7373, "switch-fixture");
  const access = installReviewRoutes(app, repositories),
    queue = new RepositoryQueue();
  installBranchSwitchRoutes(app, repositories, access, {
    queue,
    enableWrites: options.writes ?? true,
    assertIdle: options.idle ?? (async () => {}),
    now: options.now,
  });
  app.setErrorHandler((_e, _r, reply) =>
    reply.code(500).send({ error: "Unexpected fixture failure" }),
  );
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const session = await app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "switch-fixture" },
  });
  const auth = {
    ...headers,
    cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
  };
  const url = `/api/repositories/${repo.id}`;
  const post = (suffix: string, payload: object, customHeaders = auth) =>
    app.inject({
      method: "POST",
      url: url + suffix,
      headers: customHeaders,
      payload,
    });
  const review = async () => {
    const response = await app.inject({
      url: url + "/review?base=HEAD&mode=branch",
      headers: auth,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const preview = async (targetRef = "refs/heads/other") =>
    post("/branch-switch-preview", {
      reviewId: (await review()).id,
      targetRef,
    });
  const switchTo = async (strategy = "clean", extra = {}) => {
    const p = await preview();
    expect(p.statusCode, p.body).toBe(200);
    return post("/branch-switch", {
      previewId: p.json().previewId,
      strategy,
      ...extra,
    });
  };
  const state = async () => ({
    head: git("rev-parse", "HEAD"),
    branch: git("symbolic-ref", "HEAD"),
    index: await readFile(join(repo.gitDir, "index")),
    a: await readFile(join(root, "a.txt")),
    b: await readFile(join(root, "b.txt")),
    refs: git("show-ref"),
    status: git("status", "--porcelain=v1", "--untracked-files=all"),
  });
  return {
    root,
    git,
    repo,
    repositories,
    app,
    queue,
    auth,
    url,
    post,
    review,
    preview,
    switchTo,
    state,
    original,
    target,
  };
}

test("clean preview switches the exact existing branch without moving either branch ref", async () => {
  const f = await fixture(),
    p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json()).toMatchObject({
    status: "clean",
    from: { branch: "refs/heads/main", head: f.original },
    target: { branch: "refs/heads/other", head: f.target },
    dirty: { staged: [], unstaged: [], untracked: [] },
  });
  const result = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "clean",
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    ok: true,
    outcome: "switched",
    branch: "refs/heads/other",
    head: f.target,
  });
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/other");
  expect(f.git("rev-parse", "main")).toBe(f.original);
  expect(f.git("rev-parse", "other")).toBe(f.target);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("other\n");
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.repositories.get(f.repo.id)).toMatchObject({
    branch: "refs/heads/other",
    head: f.target,
    root: f.repo.root,
    gitDir: f.repo.gitDir,
    commonDir: f.repo.commonDir,
  });
  expect(
    (
      await f.post("/branch-switch", {
        previewId: p.json().previewId,
        strategy: "clean",
      })
    ).statusCode,
  ).toBe(409);
});

test.each(["unstaged", "staged", "untracked"] as const)(
  "%s work blocks automatic switching without changing any source/index/ref bytes",
  async (kind) => {
    const f = await fixture();
    await writeFile(
      join(f.root, kind === "untracked" ? "new.txt" : "a.txt"),
      "private unsaved bytes\n",
    );
    if (kind === "staged") f.git("add", "a.txt");
    const before = await f.state(),
      p = await f.preview();
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().status).toBe("dirty");
    expect(p.json().dirty[kind]).toContain(
      kind === "untracked" ? "new.txt" : "a.txt",
    );
    const r = await f.post("/branch-switch", {
      previewId: p.json().previewId,
      strategy: "clean",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      outcome: "not-switched",
      reason: "dirty",
    });
    expect(await f.state()).toEqual(before);
  },
);

test("same actual branch is an index-preserving no-op even with dirty files", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "keep dirty\n");
  const before = await f.state(),
    p = await f.preview("refs/heads/main");
  expect(p.json().status).toBe("same-branch");
  const r = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "clean",
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().outcome).toBe("same-branch");
  expect(await f.state()).toEqual(before);
});

test.each(["source", "index", "target", "config", "branch-identity"])(
  "a changed %s invalidates preview with no additional writes",
  async (change) => {
    const f = await fixture(),
      p = await f.preview();
    if (change === "source")
      await writeFile(join(f.root, "a.txt"), "external edits\n");
    if (change === "index")
      f.git("update-index", "--assume-unchanged", "b.txt");
    if (change === "target")
      f.git("update-ref", "refs/heads/other", f.original);
    if (change === "config")
      f.git("config", "branch.other.description", "changed");
    if (change === "branch-identity") {
      f.git("branch", "twin");
      f.git("switch", "-q", "twin");
    }
    const before = await f.state(),
      r = await f.post("/branch-switch", {
        previewId: p.json().previewId,
        strategy: "clean",
      });
    expect(r.statusCode, r.body).toBe(409);
    expect(await f.state()).toEqual(before);
  },
);

test("same OID on a different branch still checks out that branch identity", async () => {
  const f = await fixture();
  f.git("branch", "twin");
  const p = await f.preview("refs/heads/twin");
  expect(p.json().status).toBe("clean");
  const r = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "clean",
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/twin");
});

test("occupied local branches identify only an already registered worktree for opening", async () => {
  const f = await fixture(),
    otherRoot = await mkdtemp(join(tmpdir(), "review-owned-linked-"));
  roots.push(otherRoot);
  f.git("worktree", "add", "--quiet", otherRoot, "other");
  const occupied = await f.preview();
  expect(occupied.json()).toMatchObject({
    status: "occupied",
    occupied: { root: otherRoot, branch: "refs/heads/other", head: f.target },
  });
  expect(occupied.json().occupied.repositoryId).toBeUndefined();
  const linked = await registerRepository(otherRoot);
  f.repositories.set(linked.id, linked);
  const registered = await f.preview();
  expect(registered.json().occupied.repositoryId).toBe(linked.id);
  expect(
    (
      await f.post("/branch-switch", {
        previewId: registered.json().previewId,
        strategy: "clean",
      })
    ).statusCode,
  ).toBe(409);
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("stash requires an explicit choice and retains tracked, staged and untracked recovery by exact OID", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "staged a\n");
  f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "unstaged a\n");
  await writeFile(join(f.root, "new.txt"), "new untracked\n");
  const before = await f.state(),
    denied = await f.switchTo("stash");
  expect(denied.statusCode).toBe(400);
  expect(await f.state()).toEqual(before);
  const r = await f.switchTo("stash", { confirmed: true });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({
    outcome: "switched",
    stash: { sourceBranch: "refs/heads/main" },
  });
  const oid = r.json().stash.oid;
  expect(f.git("rev-parse", "refs/stash")).toBe(oid);
  expect(f.git("show", `${oid}:a.txt`)).toBe("unstaged a");
  expect(f.git("show", `${oid}^2:a.txt`)).toBe("staged a");
  expect(f.git("show", `${oid}^3:new.txt`)).toBe("new untracked");
  expect(f.git("rev-parse", `${oid}^1`)).toBe(f.original);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.git("rev-parse", "main")).toBe(f.original);
});

test("commit switches only after selected staged files and the supplied message leave a clean tree", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "b.txt"), "selected b\n");
  f.git("add", "b.txt");
  const r = await f.switchTo("commit", {
    confirmed: true,
    commit: { paths: ["b.txt"], message: "Save selected work" },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().commit).toMatch(/^[a-f0-9]{40}$/);
  expect(f.git("show", "main:b.txt")).toBe("selected b");
  expect(f.git("log", "-1", "--format=%s", "main")).toBe("Save selected work");
  expect(f.git("rev-parse", "other")).toBe(f.target);
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/other");
});

describe("commit with remaining edits", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let r: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["switchTo"]>>;
  beforeEach(async () => {
    f = await fixture();
    await writeFile(join(f.root, "b.txt"), "selected b\n");
    f.git("add", "b.txt");
    await writeFile(join(f.root, "a.txt"), "unstaged a\n");
    await writeFile(join(f.root, "new.txt"), "untracked\n");
    r = await f.switchTo("commit", {
      confirmed: true,
      commit: { paths: ["b.txt"], message: "Only b" },
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().outcome).toBe("saved-not-switched");
  }, 5000);
  test("saves selected staged work and returns an explicit remaining-dirty decision", async () => {
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({
      outcome: "saved-not-switched",
      reason: "remaining-dirty",
      remainingDirty: { unstaged: ["a.txt"], untracked: ["new.txt"] },
    });
    expect(f.git("rev-parse", "main")).toBe(r.json().commit);
    expect(f.repositories.get(f.repo.id)).toMatchObject({
      branch: "refs/heads/main",
      head: r.json().commit,
    });
    expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(f.git("show", "main:a.txt")).toBe("main");
    expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("unstaged a\n");
    expect(f.git("stash", "list")).toBe("");
  });
  test("allows an explicit stash decision after saving without switching", async () => {
    const continued = await f.switchTo("stash", { confirmed: true });
    expect(continued.statusCode, continued.body).toBe(200);
  });
});

test("ignored files that target would overwrite are preserved and Git refusal does not change HEAD", async () => {
  const f = await fixture();
  f.git("switch", "-q", "other");
  await writeFile(join(f.root, "ignored.txt"), "target tracked\n");
  f.git("add", "ignored.txt");
  f.git("commit", "-qm", "target ignored collision");
  f.git("switch", "-q", "main");
  await writeFile(join(f.repo.gitDir, "info", "exclude"), "ignored.txt\n");
  await writeFile(join(f.root, "ignored.txt"), "precious ignored bytes\n");
  const r = await f.switchTo();
  expect(r.statusCode, r.body).toBe(409);
  expect(await readFile(join(f.root, "ignored.txt"), "utf8")).toBe(
    "precious ignored bytes\n",
  );
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("active execution and an already queued operation block switch preview", async () => {
  const f = await fixture({
    idle: async () => {
      throw new Error("active execution");
    },
  });
  expect((await f.preview()).statusCode).toBe(409);
  const g = await fixture();
  let release!: () => void;
  const pending = g.queue.run(
    g.repo.id,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  expect((await g.preview()).statusCode).toBe(409);
  release();
  await pending;
});

test("write opt-in, session and origin guards precede branch operations", async () => {
  const f = await fixture({ writes: false });
  expect((await f.preview()).statusCode).toBe(403);
  const g = await fixture(),
    payload = {
      reviewId: (await g.review()).id,
      targetRef: "refs/heads/other",
    };
  expect(
    (await g.post("/branch-switch-preview", payload, { ...g.auth, cookie: "" }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await g.post("/branch-switch-preview", payload, {
        ...g.auth,
        origin: "https://attacker.test",
      })
    ).statusCode,
  ).toBe(403);
});

test.each([
  "other",
  "HEAD",
  "refs/remotes/origin/other",
  "refs/heads/other^",
  "--force",
  "refs/heads/missing",
])("rejects non-direct or unavailable branch selection %s", async (target) => {
  const f = await fixture(),
    before = await f.state();
  expect((await f.preview(target)).statusCode).toBe(400);
  expect(await f.state()).toEqual(before);
});

test("branch mutation boundary rejects argv expansion and preserves generic plumbing allowlist", async () => {
  const f = await fixture(),
    before = await f.state();
  for (const args of [
    ["switch", "--force", "other"],
    ["stash", "pop"],
    ["reset", "--hard"],
    [
      "switch",
      "--no-guess",
      "--no-recurse-submodules",
      "--no-overwrite-ignore",
      "--",
      "--force",
    ],
  ])
    await expect(writeBranchGit(f.repo, args)).rejects.toThrow();
  await expect(writeGit(f.repo, ["switch", "other"])).rejects.toThrow(
    "Unsupported Git operation",
  );
  expect(await f.state()).toEqual(before);
});

test("stash recovery remains identifiable when checkout is refused by an ignored-file collision", async () => {
  const f = await fixture();
  f.git("switch", "-q", "other");
  await writeFile(join(f.root, "secret.txt"), "target\n");
  f.git("add", "secret.txt");
  f.git("commit", "-qm", "collision");
  f.git("switch", "-q", "main");
  await writeFile(join(f.repo.gitDir, "info", "exclude"), "secret.txt\n");
  await writeFile(join(f.root, "secret.txt"), "ignored bytes\n");
  await writeFile(join(f.root, "a.txt"), "saved source\n");
  const r = await f.switchTo("stash", { confirmed: true });
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json()).toMatchObject({
    reason: "git-refused",
    outcome: "saved-not-switched",
    stash: { sourceBranch: "refs/heads/main" },
  });
  expect(f.git("rev-parse", "refs/stash")).toBe(r.json().stash.oid);
  expect(f.git("show", `${r.json().stash.oid}:a.txt`)).toBe("saved source");
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await readFile(join(f.root, "secret.txt"), "utf8")).toBe(
    "ignored bytes\n",
  );
  expect(
    f.git("ls-tree", "-r", "--name-only", `${r.json().stash.oid}^3`),
  ).not.toContain("secret.txt");
});

test("stash handles pathspec-shaped filenames literally and leaves ignored files in place", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ":(glob)*"), "literal filename\n");
  await writeFile(join(f.root, "ignored.txt"), "ignored bytes\n");
  await writeFile(join(f.repo.gitDir, "info", "exclude"), "ignored.txt\n");
  const r = await f.switchTo("stash", { confirmed: true });
  expect(r.statusCode, r.body).toBe(200);
  expect(f.git("show", `${r.json().stash.oid}^3::(glob)*`)).toBe(
    "literal filename",
  );
  expect(await readFile(join(f.root, "ignored.txt"), "utf8")).toBe(
    "ignored bytes\n",
  );
  await expect(access(join(f.root, ":(glob)*"))).rejects.toThrow();
});

test("stash refuses an ignored replacement for a source file removed from the index", async () => {
  const f = await fixture();
  f.git("rm", "--cached", "a.txt");
  await writeFile(join(f.repo.gitDir, "info", "exclude"), "a.txt\n");
  await writeFile(
    join(f.root, "a.txt"),
    "ignored replacement must remain here\n",
  );
  const before = await f.state(),
    p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json()).toMatchObject({
    status: "dirty",
    dirty: { staged: ["a.txt"], untracked: [] },
  });
  const result = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "stash",
    confirmed: true,
  });
  expect(result.statusCode, result.body).toBe(409);
  expect(result.json()).toMatchObject({
    outcome: "not-switched",
    reason: "unsupported",
  });
  expect(result.json().error).toMatch(/ignored.*removed from the index/i);
  expect(await f.state()).toEqual(before);
  expect(f.git("stash", "list")).toBe("");
});

test("configuration activated by checkout cannot turn an unverifiable changed checkout into not-switched", async () => {
  const f = await fixture();
  const conditional = join(f.repo.gitDir, "other-branch-config");
  await writeFile(conditional, "[invalid config\n");
  f.git("config", "includeIf.onbranch:other.path", conditional);
  const p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json().status).toBe("clean");
  const result = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "clean",
  });
  expect(result.statusCode, result.body).toBe(409);
  expect(result.json()).toMatchObject({
    outcome: "uncertain",
    reason: "git-refused",
  });
  expect(result.json().actual).toBeUndefined();
  expect(await readFile(join(f.repo.gitDir, "HEAD"), "utf8")).toBe(
    "ref: refs/heads/other\n",
  );
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("other\n");
});

test("symbolic stash refs cannot redirect saved work into a local branch", async () => {
  const f = await fixture();
  f.git("symbolic-ref", "refs/stash", "refs/heads/other");
  await writeFile(join(f.root, "a.txt"), "keep\n");
  const before = await f.state(),
    r = await f.preview();
  expect(r.statusCode, r.body).toBe(409);
  expect(await f.state()).toEqual(before);
});

test("expired plans and an agent becoming active after preview cause no mutation", async () => {
  let now = Date.now(),
    active = false;
  const f = await fixture({
    now: () => now,
    idle: () =>
      active ? Promise.reject(new Error("active")) : Promise.resolve(),
  });
  const expired = await f.preview(),
    before = await f.state();
  now += 300001;
  expect(
    (
      await f.post("/branch-switch", {
        previewId: expired.json().previewId,
        strategy: "clean",
      })
    ).statusCode,
  ).toBe(409);
  const p = await f.preview();
  active = true;
  const r = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "clean",
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().reason).toBe("busy");
  expect(await f.state()).toEqual(before);
});

test("checkout disables configured hooks, fsmonitor, signing and submodule recursion", async () => {
  const f = await fixture(),
    marker = join(f.root, "hook-ran");
  await writeFile(
    join(f.repo.gitDir, "hooks", "post-checkout"),
    `#!/bin/sh\ntouch '${marker}'\n`,
  );
  await chmod(join(f.repo.gitDir, "hooks", "post-checkout"), 0o755);
  f.git("config", "core.fsmonitor", `touch '${marker}'`);
  f.git("config", "submodule.recurse", "true");
  f.git("config", "commit.gpgSign", "true");
  const r = await f.switchTo();
  expect(r.statusCode, r.body).toBe(200);
  await expect(access(marker)).rejects.toThrow();
});

test.each(["filter", "sparse", "index-flags", "merge"])(
  "unsafe %s context fails closed without running helpers or changing bytes",
  async (kind) => {
    const f = await fixture(),
      marker = join(f.root, "helper-ran");
    if (kind === "filter")
      f.git("config", "filter.untrusted.smudge", `touch '${marker}'`);
    if (kind === "sparse") f.git("config", "core.sparseCheckout", "true");
    if (kind === "index-flags")
      f.git("update-index", "--assume-unchanged", "a.txt");
    if (kind === "merge")
      await writeFile(join(f.repo.gitDir, "MERGE_HEAD"), f.target + "\n");
    const before = await f.state(),
      r = await f.preview();
    expect(r.statusCode, r.body).toBe(409);
    expect(await f.state()).toEqual(before);
    await expect(access(marker)).rejects.toThrow();
  },
);

test.each(["symlink", "submodule"])(
  "unsupported target %s trees are refused before checkout",
  async (kind) => {
    const f = await fixture();
    f.git("switch", "-q", "other");
    if (kind === "symlink") {
      await symlink("a.txt", join(f.root, "alias"));
      f.git("add", "alias");
    } else
      f.git(
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${f.original},submodule`,
      );
    f.git("commit", "-qm", "unsupported target");
    f.git("switch", "-q", "main");
    const before = await f.state(),
      r = await f.preview();
    expect(r.statusCode, r.body).toBe(409);
    expect(await f.state()).toEqual(before);
  },
);

test("aliased HEAD metadata fails closed and leaves its destination unchanged", async () => {
  const f = await fixture(),
    destination = join(f.root, "head-backup");
  const observation = await f.review();
  await rename(join(f.repo.gitDir, "HEAD"), destination);
  await symlink(destination, join(f.repo.gitDir, "HEAD"));
  const bytes = await readFile(destination),
    r = await f.post("/branch-switch-preview", {
      reviewId: observation.id,
      targetRef: "refs/heads/other",
    });
  expect(r.statusCode, r.body).toBe(409);
  expect(await readFile(destination)).toEqual(bytes);
});

test("stash refuses conversion attributes before creating a stash or changing dirty bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ".gitattributes"), "a.txt text\n");
  await writeFile(join(f.root, "a.txt"), "dirty\r\n");
  const before = await f.state(),
    r = await f.switchTo("stash", { confirmed: true });
  expect(r.statusCode, r.body).toBe(409);
  expect(await f.state()).toEqual(before);
  expect(f.git("stash", "list")).toBe("");
});

test("invalid dirty strategies, commit paths, messages and extra fields cannot mutate the repository", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "b.txt"), "staged\n");
  f.git("add", "b.txt");
  const before = await f.state();
  for (const extra of [
    { strategy: "discard", confirmed: true },
    {
      strategy: "commit",
      confirmed: true,
      commit: { paths: ["b.txt"], message: " " },
    },
    {
      strategy: "commit",
      confirmed: true,
      commit: { paths: ["a.txt"], message: "not staged" },
    },
    { strategy: "stash", confirmed: true, args: ["--all"] },
  ]) {
    const p = await f.preview(),
      r = await f.post("/branch-switch", {
        previewId: p.json().previewId,
        ...extra,
      });
    expect(r.statusCode, r.body).toBe(400);
    expect(await f.state()).toEqual(before);
  }
});

test("raw worktree bytes hidden by Git stat-cache settings still block clean checkout", async () => {
  const f = await fixture(),
    path = join(f.root, "a.txt");
  // Establish an old whole-second stat cache, then replace equal-length bytes and
  // restore its timestamp with ctime checking disabled. Normal status misses it.
  const old = new Date(Date.now() - 60000);
  old.setMilliseconds(0);
  await utimes(path, old, old);
  f.git("update-index", "--refresh");
  f.git("config", "core.trustctime", "false");
  await writeFile(path, "evil\n");
  await utimes(path, old, old);
  expect(f.git("status", "--porcelain")).toBe("");
  const before = await f.state(),
    p = await f.preview();
  expect(p.statusCode, p.body).toBe(200);
  expect(p.json()).toMatchObject({
    status: "dirty",
    dirty: { unstaged: ["a.txt"] },
  });
  const r = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: "clean",
  });
  expect(r.statusCode).toBe(409);
  expect(await f.state()).toEqual(before);
});

test("non-string strategy payloads cannot coerce into a clean checkout", async () => {
  const f = await fixture(),
    p = await f.preview(),
    before = await f.state();
  const r = await f.post("/branch-switch", {
    previewId: p.json().previewId,
    strategy: ["clean"],
    confirmed: true,
  });
  expect(r.statusCode, r.body).toBe(400);
  expect(await f.state()).toEqual(before);
});

test("symbolic ORIG_HEAD cannot redirect stash reset bookkeeping into another branch", async () => {
  const f = await fixture();
  f.git("symbolic-ref", "ORIG_HEAD", "refs/heads/other");
  await writeFile(join(f.root, "a.txt"), "keep source\n");
  const before = await f.state(),
    r = await f.preview();
  expect(r.statusCode, r.body).toBe(409);
  expect(await f.state()).toEqual(before);
});

test.each(["-", "HEAD", "-force"])(
  "reserved checkout spelling %s is refused even when its direct local ref exists",
  async (name) => {
    const f = await fixture();
    f.git("update-ref", `refs/heads/${name}`, f.original);
    const before = await f.state(),
      r = await f.preview(`refs/heads/${name}`);
    expect(r.statusCode, r.body).toBe(400);
    expect(await f.state()).toEqual(before);
  },
);
