import { canonicalMkdtemp as mkdtemp } from "./filesystem-fixtures.js";
import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type AppOptions } from "../apps/server/src/app.js";
import { registerRepository } from "../apps/server/src/registry.js";
import * as reviews from "../packages/git/src/review.js";
import { getFileDiff } from "../packages/git/src/diff.js";
import type { ReviewMode } from "../packages/shared/src/index.js";

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const target = "refs/heads/feature/topic";
const base = "refs/remotes/origin/main";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "review-branch-targets-"));
  roots.push(dir);
  const root = join(dir, "repo"),
    state = join(dir, "state"),
    skills = join(dir, "skills");
  await mkdir(root);
  await mkdir(skills);
  await writeFile(
    join(skills, "SKILL.md"),
    "# Fixture\nReview selected findings.\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(root, "a.txt"), "base\nstable one\nstable two\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const initial = git("rev-parse", "HEAD");
  git("remote", "add", "origin", "https://example.test/repo.git");
  git("remote", "add", "upstream", "https://example.test/upstream.git");
  git("update-ref", base, initial);
  git("update-ref", "refs/remotes/upstream/release/v1", initial);
  git("symbolic-ref", "refs/remotes/origin/HEAD", base);
  git(
    "symbolic-ref",
    "refs/remotes/upstream/HEAD",
    "refs/remotes/upstream/release/v1",
  );
  git("checkout", "-qb", "feature/topic");
  await writeFile(
    join(root, "a.txt"),
    "selected branch\nstable one\nstable two\n",
  );
  git("commit", "-qam", "selected target");
  const selected = git("rev-parse", "HEAD");
  git("branch", "same/commit");
  git("checkout", "-q", "main");
  await writeFile(
    join(root, "a.txt"),
    "checked out main\nstable one\nstable two\n",
  );
  git("commit", "-qam", "main target");
  const main = git("rev-parse", "HEAD");
  return {
    root,
    state,
    skills,
    git,
    initial,
    selected,
    main,
    repo: await registerRepository(root),
  };
}
async function start(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<AppOptions> = {},
  setup?: (app: Awaited<ReturnType<typeof createApp>>) => void,
) {
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: f.state,
    repositoryPath: f.root,
    skillRoots: [f.skills],
    ...options,
  });
  apps.push(app);
  setup?.(app);
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
  const id = (
    await app.inject({ url: "/api/repositories", headers: auth })
  ).json().selectedRepositoryId;
  const call = (
    method: "GET" | "POST" | "PUT",
    suffix: string,
    payload?: object,
    revision?: number,
  ) =>
    app.inject({
      method,
      url: suffix.startsWith("/api/")
        ? suffix
        : `/api/repositories/${id}/${suffix}`,
      headers: {
        ...auth,
        ...(revision ? { "x-review-navigation": String(revision) } : {}),
      },
      payload,
    });
  const review = (
    ref: string | undefined = target,
    mode: ReviewMode = "branch",
    revision?: number,
  ) =>
    call(
      "GET",
      `review?${new URLSearchParams({ base, mode, ...(ref === undefined ? {} : { target: ref }) })}`,
      undefined,
      revision,
    );
  return { app, call, id, review };
}

test("offline branch inventory separates all local and remote full refs, retaining slash names and excluding symbolic HEAD", async () => {
  const f = await fixture();
  const a = await start(f, {
    fetchTransport: async () => {
      throw new Error("Offline reads must not fetch");
    },
  });
  const result = (await a.call("GET", "branches")).json();
  expect(result.localBranches).toEqual([
    target,
    "refs/heads/main",
    "refs/heads/same/commit",
  ]);
  expect(result.remoteBranches).toEqual([
    base,
    "refs/remotes/upstream/release/v1",
  ]);
  expect(result.branches).toEqual(result.localBranches);
  expect(result.current).toBe("refs/heads/main");
});

test("selected non-HEAD target uses merge-base and target blobs without checkout or mixing index/worktree bytes", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "a.txt"), "staged private fixture\n");
  f.git("add", ".");
  await writeFile(join(f.root, "a.txt"), "working private fixture\n");
  const index = await readFile(join(f.root, ".git/index"));
  const observed = await reviews.getReview(f.repo, base, "branch", target);
  expect(observed.head).toBe(f.selected);
  expect(observed.branch).toBe(target);
  expect(observed.targetRef).toBe(target);
  expect(observed.baseRef).toBe(base);
  expect(observed.mergeBase).toBe(f.git("merge-base", base, target));
  expect(observed.worktree).toEqual({
    head: f.main,
    branch: "refs/heads/main",
  });
  expect(observed.executionEligible).toBe(false);
  expect((await getFileDiff(f.repo, observed, "a.txt")).newContent).toBe(
    "selected branch\nstable one\nstable two\n",
  );
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await readFile(join(f.root, ".git/index"))).toEqual(index);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(
    "working private fixture\n",
  );
  expect((await reviews.getReview(f.repo, base, "branch")).head).toBe(f.main);
});

for (const mode of ["working", "staged", "full"] as const)
  test(`${mode} refuses a non-checked-out target even at the same commit`, async () => {
    const f = await fixture();
    f.git("branch", "same-main", f.main);
    await expect(
      reviews.getReview(f.repo, base, mode, "refs/heads/same-main"),
    ).rejects.toThrow(/checked.out|target|stale/i);
    const current = await reviews.getReview(
      f.repo,
      base,
      mode,
      "refs/heads/main",
    );
    expect(current.executionEligible).toBe(true);
  });

for (const changed of ["target", "base", "deleted target"] as const)
  test(`moving ${changed} invalidates live lazy observations`, async () => {
    const f = await fixture();
    const observation = await reviews.getReview(f.repo, base, "branch", target);
    if (changed === "target") f.git("update-ref", target, f.main);
    if (changed === "base") f.git("update-ref", base, f.main);
    if (changed === "deleted target") f.git("update-ref", "-d", target);
    await expect(getFileDiff(f.repo, observation, "a.txt")).rejects.toThrow(
      /stale/i,
    );
  });

test("target accepts exact direct local branch refs only and arbitrary advanced base commits remain supported", async () => {
  const f = await fixture();
  f.git("symbolic-ref", "refs/heads/alias", target);
  for (const ref of [
    "HEAD",
    "feature/topic",
    base,
    f.selected,
    "refs/heads/missing",
    "refs/heads/alias",
    "refs/heads/feature/topic~1",
  ])
    await expect(
      reviews.getReview(f.repo, base, "branch", ref),
    ).rejects.toThrow();
  expect(
    (await reviews.getReview(f.repo, f.initial, "branch", target)).head,
  ).toBe(f.selected);
  expect(
    (await reviews.getReview(f.repo, "main~1", "branch", target)).mergeBase,
  ).toBe(f.initial);
});

test("target selection, profiles, comments, reviewed state, exports and historical anchors survive restart and moved refs", async () => {
  const f = await fixture();
  const a = await start(f);
  const response = await a.review();
  expect(response.statusCode).toBe(200);
  const observed = response.json();
  expect(observed.targetRef).toBe(target);
  const comment = (
    await a.call("POST", "comments", {
      reviewId: observed.id,
      path: "a.txt",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "Target finding",
      severity: "warning",
    })
  ).json();
  expect(comment).toMatchObject({
    targetRef: target,
    head: f.selected,
    branch: target,
    baseRef: base,
  });
  const skill = (await a.call("GET", "/api/skills")).json().skills[0];
  await a.call("PUT", "profiles", {
    reviewId: observed.id,
    scope: "branch",
    profile: { locator: skill.locator, digest: skill.digest },
  });
  expect(
    (
      await a.call("PUT", "reviewed", {
        reviewId: observed.id,
        path: "a.txt",
        reviewed: true,
      })
    ).statusCode,
  ).toBe(200);
  const exported = (
    await a.call("GET", `export?reviewId=${observed.id}`)
  ).json();
  expect(exported.target).toMatchObject({
    targetRef: target,
    head: f.selected,
    branch: target,
    worktree: { head: f.main, branch: "refs/heads/main" },
    baseRef: base,
  });
  expect(exported.comments[0].attachment).toBe("current");
  expect(exported.profile.source).toBe("branch");
  const same = (await a.review("refs/heads/same/commit")).json();
  expect(same.fingerprint).not.toBe(observed.fingerprint);
  expect(
    (await a.call("GET", `comments?reviewId=${same.id}`)).json().comments[0]
      .attachment,
  ).toBe("outdated");
  expect(
    (await a.call("GET", `profiles?reviewId=${same.id}`)).json().effective,
  ).toBeNull();
  await a.review();
  await a.app.close();
  const b = await start(f, { repositoryPath: undefined });
  expect((await b.call("GET", "/api/repositories")).json()).toMatchObject({
    target,
    base,
    mode: "branch",
    contexts: { [b.id]: { target, base, mode: "branch" } },
  });
  const live = (await b.review()).json();
  expect(
    (await b.call("GET", `comments?reviewId=${live.id}`)).json().comments[0]
      .attachment,
  ).toBe("current");
  const history = (await b.call("GET", "history"))
    .json()
    .reviews.find((entry: { id: string }) => entry.id === observed.id);
  expect(history).toMatchObject({
    targetRef: target,
    head: f.selected,
    baseRef: base,
  });
  f.git("update-ref", target, f.main);
  f.git("update-ref", base, f.main);
  await b.review("refs/heads/main");
  const historicResponse = await b.call("GET", `history/${observed.id}/review`);
  expect(historicResponse.statusCode).toBe(200);
  const historic = historicResponse.json();
  expect(historic).toMatchObject({
    historical: true,
    targetRef: target,
    head: f.selected,
    executionEligible: false,
  });
  expect(
    (await b.call("GET", `diff?reviewId=${historic.id}&path=a.txt`)).json()
      .newContent,
  ).toContain("selected branch");
  expect(
    (await b.call("GET", `comments?reviewId=${historic.id}`)).json().comments[0]
      .attachment,
  ).toBe("current");
  expect(
    (
      await b.call("POST", "comments", {
        reviewId: historic.id,
        path: "a.txt",
        side: "new",
        startLine: 1,
        endLine: 1,
        body: "Historic",
        severity: "info",
      })
    ).statusCode,
  ).toBe(403);
  expect((await b.call("GET", "/api/repositories")).json().target).toBe(
    "refs/heads/main",
  );
});

test("latest accepted navigation persists target and explicit legacy omission clears it on reload/restart", async () => {
  const f = await fixture();
  let release!: () => void, enter!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const a = await start(f, {}, (app) =>
    app.addHook("preHandler", async (req) => {
      if (req.headers["x-review-navigation"] === "10") {
        enter();
        await held;
      }
    }),
  );
  const older = a.review(target, "branch", 10);
  await entered;
  expect((await a.review("refs/heads/main", "branch", 11)).statusCode).toBe(
    200,
  );
  release();
  expect((await older).statusCode).toBe(200);
  const context = (await a.call("GET", "/api/repositories")).json();
  expect(context.target).toBe("refs/heads/main");
  expect(context.contexts[a.id].target).toBe("refs/heads/main");
  // Use the legacy URL without target: this must clear the stored explicit target.
  expect(
    (await a.call("GET", `review?base=${base}&mode=branch`, undefined, 12))
      .statusCode,
  ).toBe(200);
  expect((await a.call("GET", "/api/repositories")).json().target).toBeNull();
  await a.app.close();
  const b = await start(f, { repositoryPath: undefined });
  expect((await b.call("GET", "/api/repositories")).json().target).toBeNull();
  expect(
    (await b.call("GET", "/api/repositories")).json().contexts[b.id].target ??
      null,
  ).toBeNull();
});

test("another selected branch at the same commit cannot execute agents or mutate Git", async () => {
  const f = await fixture();
  f.git("checkout", "-q", "feature/topic");
  let invoked = 0,
    fetched = 0;
  const a = await start(f, {
    enableWrites: true,
    processFactory: () => {
      invoked++;
      throw new Error("Wrong-target process must not run");
    },
    fetchTransport: async () => {
      fetched++;
    },
  });
  const observed = (await a.review("refs/heads/same/commit")).json();
  expect(observed.head).toBe(f.selected);
  expect(observed.executionEligible).toBe(false);
  const comment = (
    await a.call("POST", "comments", {
      reviewId: observed.id,
      path: "a.txt",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "Target finding",
      severity: "warning",
    })
  ).json();
  const skill = (await a.call("GET", "/api/skills")).json().skills[0];
  await a.call("PUT", "profiles", {
    reviewId: observed.id,
    scope: "branch",
    profile: { locator: skill.locator, digest: skill.digest },
  });
  const exported = (
    await a.call("GET", `export?reviewId=${observed.id}`)
  ).json();
  expect(
    (
      await a.call("POST", "agents", {
        adapter: "codex",
        reviewId: observed.id,
        commentIds: [comment.id],
        expected: { target: exported.target, profile: exported.profile },
      })
    ).statusCode,
  ).toBe(409);
  for (const [endpoint, payload] of [
    ["git", { action: "stage", path: "a.txt" }],
    ["discard-preview", { path: "a.txt" }],
    ["commit", { paths: ["a.txt"], message: "Must not write" }],
    ["fetch", { remote: "origin", expectedHead: f.selected }],
  ] as const)
    expect(
      (await a.call("POST", endpoint, { reviewId: observed.id, ...payload }))
        .statusCode,
    ).toBe(409);
  expect(invoked).toBe(0);
  expect(fetched).toBe(0);
  expect(f.git("symbolic-ref", "HEAD")).toBe(target);
  expect(f.git("status", "--porcelain")).toBe("");
});

test("explicit controlled Fetch invalidates captured remote base and refreshed observations use the updated ref", async () => {
  const f = await fixture();
  let fetched = 0;
  const a = await start(f, {
    enableWrites: true,
    fetchTransport: async () => {
      fetched++;
      f.git("update-ref", base, f.main);
      f.git("update-ref", "refs/remotes/upstream/new/topic", f.selected);
    },
  });
  const observed = (await a.review("refs/heads/main")).json();
  expect(
    (
      await a.call("POST", "fetch", {
        reviewId: observed.id,
        remote: "origin",
        expectedHead: f.main,
      })
    ).statusCode,
  ).toBe(200);
  expect(fetched).toBe(1);
  expect(
    (await a.call("GET", `diff?reviewId=${observed.id}&path=a.txt`)).statusCode,
  ).toBe(409);
  expect((await a.review("refs/heads/main")).json()).toMatchObject({
    base: f.main,
    mergeBase: f.main,
    files: [],
  });
  expect((await a.call("GET", "branches")).json().remoteBranches).toContain(
    "refs/remotes/upstream/new/topic",
  );
});

test("legacy detached-HEAD working review retains supported index operations", async () => {
  const f = await fixture();
  f.git("checkout", "--detach", "-q", f.main);
  await writeFile(join(f.root, "a.txt"), "detached working change\n");
  const a = await start(f, { enableWrites: true });
  const observed = (
    await a.call("GET", `review?base=${base}&mode=working`)
  ).json();
  expect(observed.branch).toBeNull();
  expect(
    (
      await a.call("POST", "git", {
        reviewId: observed.id,
        path: "a.txt",
        action: "stage",
      })
    ).statusCode,
  ).toBe(200);
  expect(f.git("show", ":a.txt")).toBe("detached working change");
});

test("changing checkout to an equal-OID branch keeps read-only target review but revokes execution", async () => {
  const f = await fixture();
  f.git("checkout", "-q", "feature/topic");
  let invoked = 0;
  const a = await start(f, {
    enableWrites: true,
    processFactory: () => {
      invoked++;
      throw new Error("Changed-checkout process must not run");
    },
  });
  const observed = (await a.review()).json();
  expect(observed.executionEligible).toBe(true);
  const comment = (
    await a.call("POST", "comments", {
      reviewId: observed.id,
      path: "a.txt",
      side: "new",
      startLine: 1,
      endLine: 1,
      body: "Target finding",
      severity: "warning",
    })
  ).json();
  const skill = (await a.call("GET", "/api/skills")).json().skills[0];
  await a.call("PUT", "profiles", {
    reviewId: observed.id,
    scope: "branch",
    profile: { locator: skill.locator, digest: skill.digest },
  });
  const exported = (
    await a.call("GET", `export?reviewId=${observed.id}`)
  ).json();
  f.git("checkout", "-q", "same/commit");
  expect(
    (await a.call("GET", `diff?reviewId=${observed.id}&path=a.txt`)).statusCode,
  ).toBe(200);
  expect(
    (
      await a.call("POST", "agents", {
        adapter: "codex",
        reviewId: observed.id,
        commentIds: [comment.id],
        expected: { target: exported.target, profile: exported.profile },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await a.call("POST", "git", {
        reviewId: observed.id,
        action: "stage",
        path: "a.txt",
      })
    ).statusCode,
  ).toBe(409);
  expect(invoked).toBe(0);
  expect(f.git("symbolic-ref", "HEAD")).toBe("refs/heads/same/commit");
});

test("invalid target requests and lazy older observations never replace the accepted target context", async () => {
  const f = await fixture();
  const a = await start(f);
  const old = (await a.review()).json();
  await a.review("refs/heads/main");
  expect(
    (await a.call("GET", `diff?reviewId=${old.id}&path=a.txt`)).statusCode,
  ).toBe(200);
  expect((await a.call("GET", "/api/repositories")).json().target).toBe(
    "refs/heads/main",
  );
  for (const query of [
    "target=",
    "target=HEAD",
    "target=refs%2Fheads%2Fmissing",
    "target=refs%2Fheads%2Fmain&target=refs%2Fheads%2Ffeature%2Ftopic",
  ]) {
    expect(
      (await a.call("GET", `review?base=${base}&mode=branch&${query}`))
        .statusCode,
    ).toBe(400);
    expect((await a.call("GET", "/api/repositories")).json().target).toBe(
      "refs/heads/main",
    );
  }
});

test("explicit launch flags preserve legacy HEAD targeting over an older saved branch selection", async () => {
  const f = await fixture();
  const a = await start(f);
  await a.review();
  await a.app.close();
  const b = await start(f, { mode: "working", base: "HEAD" });
  expect((await b.call("GET", "/api/repositories")).json()).toMatchObject({
    target: null,
    mode: "working",
    base: "HEAD",
  });
});

test("legacy context tables migrate without losing saved comparison state", async () => {
  const f = await fixture();
  await mkdir(f.state);
  const db = new DatabaseSync(join(f.state, "review.sqlite"));
  db.exec(
    "CREATE TABLE registration_context(repository_id TEXT PRIMARY KEY, base TEXT NOT NULL, mode TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO registration_context VALUES(?,?,?)").run(
    f.repo.id,
    base,
    "branch",
  );
  db.close();
  const a = await start(f);
  expect((await a.call("GET", "/api/repositories")).json()).toMatchObject({
    base,
    mode: "branch",
    target: null,
  });
  expect((await a.review()).statusCode).toBe(200);
  await a.app.close();
  const b = await start(f, { repositoryPath: undefined });
  expect((await b.call("GET", "/api/repositories")).json()).toMatchObject({
    base,
    mode: "branch",
    target,
  });
});
