import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, symlink, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as reviewModule from "../packages/git/src/review.js";
import { createApp } from "../apps/server/src/app.js";
const dirs: string[] = [],
  apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "review-projects-"));
  dirs.push(dir);
  const state = join(dir, "state"),
    first = join(dir, "first"),
    second = join(dir, "second");
  for (const root of [first, second]) {
    execFileSync("git", ["init", "-q", "--initial-branch=main", root]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    ]);
  }
  return { dir, state, first, second };
}
async function start(
  state: string,
  root?: string,
  setup?: (app: Awaited<ReturnType<typeof createApp>>) => void,
) {
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: state,
    repositoryPath: root,
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
  return {
    app,
    auth,
    get: () => app.inject({ url: "/api/repositories", headers: auth }),
    register: (path: string) =>
      app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: auth,
        payload: { path },
      }),
    select: (id: string) =>
      app.inject({
        method: "PUT",
        url: `/api/repositories/${id}/selection`,
        headers: auth,
        payload: {},
      }),
  };
}
test("canonical registered projects and exact selected worktree survive a restart", async () => {
  const f = await fixture();
  const a = await start(f.state, f.first);
  const firstId = (await a.get()).json().selectedRepositoryId;
  const alias = join(f.dir, "alias");
  await symlink(f.second, alias);
  expect((await a.register(alias)).statusCode).toBe(200);
  expect((await a.select(firstId)).statusCode).toBe(200);
  await a.app.close();
  const b = await start(f.state);
  expect((await b.get()).json()).toMatchObject({
    selectedRepositoryId: firstId,
    repositories: expect.arrayContaining([
      expect.objectContaining({ root: f.first }),
      expect.objectContaining({ root: f.second }),
    ]),
    errors: [],
  });
});
test("inaccessible persisted root is skipped with a visible error and retried next launch", async () => {
  const f = await fixture();
  const a = await start(f.state, f.first);
  await a.register(f.second);
  await a.app.close();
  await rename(f.second, join(f.dir, "missing"));
  const b = await start(f.state);
  const result = (await b.get()).json();
  expect(result.repositories.map((r: any) => r.root)).toEqual([f.first]);
  expect(result.errors).toEqual([
    expect.objectContaining({
      root: f.second,
      error: expect.stringMatching(/unavailable|inaccessible/i),
    }),
  ]);
  await b.app.close();
  await rename(join(f.dir, "missing"), f.second);
  const c = await start(f.state);
  expect((await c.get()).json().repositories).toHaveLength(2);
});
test("restoration refuses a root redirected through a new filesystem alias", async () => {
  const f = await fixture();
  const a = await start(f.state, f.first);
  await a.app.close();
  const moved = join(f.dir, "moved");
  await rename(f.first, moved);
  await symlink(moved, f.first);
  const b = await start(f.state);
  expect((await b.get()).json()).toMatchObject({
    repositories: [],
    selectedRepositoryId: null,
    errors: [expect.objectContaining({ root: f.first })],
  });
});
test("selection only accepts an explicitly registered repository and rejects unknown body fields", async () => {
  const f = await fixture();
  const a = await start(f.state, f.first);
  expect((await a.select("unknown")).statusCode).toBe(404);
});

test("last successful live comparison context is restored per repository, with explicit launch root/flags taking precedence", async () => {
  const f = await fixture();
  const a = await start(f.state, f.first);
  const firstId = (await a.get()).json().selectedRepositoryId;
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const session = await a.app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "fixture" },
  });
  const auth = {
    ...headers,
    cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
  };
  expect(
    (
      await a.app.inject({
        url: `/api/repositories/${firstId}/review?base=main&mode=working`,
        headers: auth,
      })
    ).statusCode,
  ).toBe(200);
  const secondId = (await a.register(f.second)).json().id;
  expect(
    (
      await a.app.inject({
        url: `/api/repositories/${secondId}/review?base=HEAD&mode=staged`,
        headers: auth,
      })
    ).statusCode,
  ).toBe(200);
  await a.app.close();
  const b = await start(f.state);
  expect((await b.get()).json()).toMatchObject({
    selectedRepositoryId: secondId,
    base: "HEAD",
    mode: "staged",
    contexts: {
      [firstId]: { base: "main", mode: "working" },
      [secondId]: { base: "HEAD", mode: "staged" },
    },
  });
  await b.app.close();
  const explicit = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: f.state,
    repositoryPath: f.first,
    base: "HEAD",
    mode: "branch",
  });
  apps.push(explicit);
  const login = await explicit.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "fixture" },
  });
  const result = await explicit.inject({
    url: "/api/repositories",
    headers: {
      ...headers,
      cookie: login.headers["set-cookie"]!.toString().split(";")[0]!,
    },
  });
  expect(result.json()).toMatchObject({
    selectedRepositoryId: firstId,
    base: "HEAD",
    mode: "branch",
  });
});

test("same-path replacement is unavailable until explicitly reopened without changing established root IDs", async () => {
  const f = await fixture();
  const a = await start(f.state, f.first);
  const savedId = (await a.get()).json().selectedRepositoryId;
  await a.app.close();
  await rename(f.first, join(f.dir, "old-first"));
  await rename(f.second, f.first);
  const b = await start(f.state);
  expect((await b.get()).json()).toMatchObject({
    repositories: [],
    errors: [expect.objectContaining({ root: f.first })],
  });
  const reopened = await b.register(f.first);
  expect(reopened.statusCode).toBe(200);
  expect(reopened.json().id).toBe(savedId);
  expect((await b.get()).json().errors).toEqual([]);
});

function gate() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => (resolve = done)),
    resolve: () => resolve(),
  };
}
test("older successful review completion cannot replace a newer accepted context in reload or restart", async () => {
  const f = await fixture(),
    a = await start(f.state, f.first),
    id = (await a.get()).json().selectedRepositoryId;
  const entered = gate(),
    held = gate(),
    original = reviewModule.getReview;
  vi.spyOn(reviewModule, "getReview").mockImplementation(
    async (repo, base, mode) => {
      if (mode === "working") {
        entered.resolve();
        await held.promise;
      }
      return original(repo, base, mode);
    },
  );
  const older = a.app.inject({
    url: `/api/repositories/${id}/review?base=main&mode=working`,
    headers: a.auth,
  });
  await entered.promise;
  expect(
    (
      await a.app.inject({
        url: `/api/repositories/${id}/review?base=HEAD&mode=staged`,
        headers: a.auth,
      })
    ).statusCode,
  ).toBe(200);
  held.resolve();
  expect((await older).statusCode).toBe(200);
  expect((await a.get()).json()).toMatchObject({
    base: "HEAD",
    mode: "staged",
    contexts: { [id]: { base: "HEAD", mode: "staged" } },
  });
  await a.app.close();
  const restarted = await start(f.state);
  expect((await restarted.get()).json()).toMatchObject({
    selectedRepositoryId: id,
    base: "HEAD",
    mode: "staged",
  });
});
test("navigation versions reject an older selection delayed before its handler and retain the newer root after restart", async () => {
  const f = await fixture(),
    entered = gate(),
    held = gate();
  const a = await start(f.state, f.first, (app) =>
    app.addHook("preHandler", async (req) => {
      if (req.method === "PUT" && req.headers["x-review-navigation"] === "20") {
        entered.resolve();
        await held.promise;
      }
    }),
  );
  const firstId = (await a.get()).json().selectedRepositoryId,
    secondId = (await a.register(f.second)).json().id;
  const older = a.app.inject({
    method: "PUT",
    url: `/api/repositories/${firstId}/selection`,
    headers: { ...a.auth, "x-review-navigation": "20" },
    payload: {},
  });
  await entered.promise;
  expect(
    (
      await a.app.inject({
        method: "PUT",
        url: `/api/repositories/${secondId}/selection`,
        headers: { ...a.auth, "x-review-navigation": "21" },
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
  held.resolve();
  await older;
  expect((await a.get()).json().selectedRepositoryId).toBe(secondId);
  await a.app.close();
  const restarted = await start(f.state);
  expect((await restarted.get()).json().selectedRepositoryId).toBe(secondId);
});
test("an old versioned registration delayed before its handler adds inventory without changing the newer selected root", async () => {
  const f = await fixture(),
    entered = gate(),
    held = gate();
  const a = await start(f.state, f.first, (app) =>
    app.addHook("preHandler", async (req) => {
      if (
        req.method === "POST" &&
        req.url === "/api/repositories" &&
        req.headers["x-review-navigation"] === "40"
      ) {
        entered.resolve();
        await held.promise;
      }
    }),
  );
  const firstId = (await a.get()).json().selectedRepositoryId;
  const older = a.app.inject({
    method: "POST",
    url: "/api/repositories",
    headers: { ...a.auth, "x-review-navigation": "40" },
    payload: { path: f.second },
  });
  await entered.promise;
  await a.app.inject({
    method: "PUT",
    url: `/api/repositories/${firstId}/selection`,
    headers: { ...a.auth, "x-review-navigation": "41" },
    payload: {},
  });
  held.resolve();
  expect((await older).statusCode).toBe(200);
  expect((await a.get()).json()).toMatchObject({
    selectedRepositoryId: firstId,
    repositories: expect.arrayContaining([
      expect.objectContaining({ root: f.second }),
    ]),
  });
});
test("successful selected-root navigation replaces launch flags in GET repositories while a new explicit launch still takes precedence", async () => {
  const f = await fixture();
  const app = await createApp({
    port: 7373,
    token: "fixture",
    dataDir: f.state,
    repositoryPath: f.first,
    base: "HEAD",
    mode: "branch",
  });
  apps.push(app);
  const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
  const login = await app.inject({
    method: "POST",
    url: "/api/session",
    headers,
    payload: { token: "fixture" },
  });
  const auth = {
    ...headers,
    cookie: login.headers["set-cookie"]!.toString().split(";")[0]!,
  };
  const initial = (
    await app.inject({ url: "/api/repositories", headers: auth })
  ).json();
  expect(initial).toMatchObject({ base: "HEAD", mode: "branch" });
  await app.inject({
    url: `/api/repositories/${initial.selectedRepositoryId}/review?base=main&mode=staged`,
    headers: auth,
  });
  const reload = (
    await app.inject({ url: "/api/repositories", headers: auth })
  ).json();
  expect(reload).toMatchObject({ base: "main", mode: "staged" });
  await app.close();
  const restarted = await start(f.state);
  expect((await restarted.get()).json()).toMatchObject({
    base: "main",
    mode: "staged",
  });
});

test("a lower-revision review arriving while a newer review runs cannot disqualify the newer accepted context", async () => {
  const f = await fixture(),
    a = await start(f.state, f.first),
    id = (await a.get()).json().selectedRepositoryId;
  const entered = gate(),
    held = gate(),
    original = reviewModule.getReview;
  vi.spyOn(reviewModule, "getReview").mockImplementation(
    async (repo, base, mode) => {
      if (mode === "staged") {
        entered.resolve();
        await held.promise;
      }
      return original(repo, base, mode);
    },
  );
  const newer = a.app.inject({
    url: `/api/repositories/${id}/review?base=HEAD&mode=staged`,
    headers: { ...a.auth, "x-review-navigation": "12" },
  });
  await entered.promise;
  expect(
    (
      await a.app.inject({
        url: `/api/repositories/${id}/review?base=main&mode=working`,
        headers: { ...a.auth, "x-review-navigation": "11" },
      })
    ).statusCode,
  ).toBe(200);
  held.resolve();
  expect((await newer).statusCode).toBe(200);
  expect((await a.get()).json()).toMatchObject({
    base: "HEAD",
    mode: "staged",
    contexts: { [id]: { base: "HEAD", mode: "staged" } },
  });
});

test("versioned registration without a current follow-up selection retains inventory and the prior durable root", async () => {
  const f = await fixture(),
    a = await start(f.state, f.first),
    id = (await a.get()).json().selectedRepositoryId;
  expect(
    (
      await a.app.inject({
        method: "POST",
        url: "/api/repositories",
        headers: { ...a.auth, "x-review-navigation": "100" },
        payload: { path: f.second },
      })
    ).statusCode,
  ).toBe(200);
  expect((await a.get()).json()).toMatchObject({
    selectedRepositoryId: id,
    repositories: expect.arrayContaining([
      expect.objectContaining({ root: f.second }),
    ]),
  });
  await a.app.close();
  const restarted = await start(f.state);
  expect((await restarted.get()).json()).toMatchObject({
    selectedRepositoryId: id,
    repositories: expect.arrayContaining([
      expect.objectContaining({ root: f.second }),
    ]),
  });
});
test("legacy selections still use admission ordering when an older handler is delayed", async () => {
  const f = await fixture(),
    entered = gate(),
    held = gate();
  let blocked = false;
  const a = await start(f.state, f.first, (app) =>
    app.addHook("preHandler", async (req) => {
      if (req.method === "PUT" && !blocked) {
        blocked = true;
        entered.resolve();
        await held.promise;
      }
    }),
  );
  const firstId = (await a.get()).json().selectedRepositoryId,
    secondId = (await a.register(f.second)).json().id;
  const older = a.select(firstId);
  await entered.promise;
  await a.select(secondId);
  held.resolve();
  await older;
  expect((await a.get()).json().selectedRepositoryId).toBe(secondId);
});
test.each(["bad", "-1", "9007199254740991"])(
  "invalid navigation revision %s cannot select a registered target",
  async (revision) => {
    const f = await fixture(),
      a = await start(f.state, f.first),
      id = (await a.get()).json().selectedRepositoryId;
    const response = await a.app.inject({
      method: "PUT",
      url: `/api/repositories/${id}/selection`,
      headers: { ...a.auth, "x-review-navigation": revision },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect((await a.get()).json().selectedRepositoryId).toBe(id);
  },
);
