import { test, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewStore } from "../packages/review/src/store.js";
import { RegistrationStore } from "../apps/server/src/registration.js";
import { registerRepository } from "../apps/server/src/registry.js";
import { refreshRegisteredRepositories } from "../apps/server/src/repository-refresh.js";
const roots: string[] = [];
const stores: ReviewStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-registration-refresh-"));
  roots.push(root);
  const repoRoot = join(root, "repo");
  await mkdir(repoRoot);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoRoot, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Refresh Fixture");
  git("config", "user.email", "refresh@example.invalid");
  await writeFile(join(repoRoot, "file"), "source\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const repo = await registerRepository(repoRoot);
  const store = new ReviewStore(join(root, "state"));
  stores.push(store);
  const registration = new RegistrationStore(store.db);
  await registration.save(repo);
  return { root, repoRoot, repo, registration };
}
test("a returned exact registered root becomes available without discovering unknown siblings", async () => {
  const f = await fixture();
  await rename(f.repoRoot, f.repoRoot + "-away");
  const initial = await f.registration.restore(() => {});
  expect(initial.repositories).toEqual([]);
  const repos = new Map(initial.repositories.map((repo) => [repo.id, repo]));
  await rename(f.repoRoot + "-away", f.repoRoot);
  await mkdir(join(f.root, "unregistered"));
  const validated: string[] = [];
  const errors = await refreshRegisteredRepositories(
    f.registration,
    repos,
    (repo) => validated.push(repo.root),
  );
  expect(errors).toEqual([]);
  expect([...repos.keys()]).toEqual([f.repo.id]);
  expect(validated).toEqual([f.repoRoot]);
});
test("replacement directories never inherit the saved physical authorization", async () => {
  const f = await fixture();
  await rename(f.repoRoot, f.repoRoot + "-original");
  execFileSync("git", [
    "clone",
    "--no-hardlinks",
    "-q",
    f.repoRoot + "-original",
    f.repoRoot,
  ]);
  const repos = new Map();
  const errors = await refreshRegisteredRepositories(
    f.registration,
    repos,
    () => {},
  );
  expect(repos.size).toBe(0);
  expect(errors).toHaveLength(1);
  expect(errors[0].root).toBe(f.repoRoot);
});
test("temporarily unavailable known roots stay visible but are not reauthorized", async () => {
  const f = await fixture();
  const repos = new Map([[f.repo.id, f.repo]]);
  await rename(f.repoRoot, f.repoRoot + "-away");
  const errors = await refreshRegisteredRepositories(
    f.registration,
    repos,
    () => {},
  );
  expect(errors).toHaveLength(1);
  expect(repos.get(f.repo.id)).toEqual(f.repo);
});

test("refresh retains the admitted object identity for already available roots", async () => {
  const f = await fixture();
  const repos = new Map([[f.repo.id, f.repo]]);
  expect(
    await refreshRegisteredRepositories(f.registration, repos, () => {}),
  ).toEqual([]);
  expect(repos.get(f.repo.id)).toBe(f.repo);
});

test("dynamic HTTP registration binds sync identity before its first use", async () => {
  const f = await fixture();
  execFileSync("git", [
    "-C",
    f.repoRoot,
    "remote",
    "add",
    "origin",
    "https://example.invalid/owned.git",
  ]);
  const { createApp } = await import("../apps/server/src/app.js");
  let fetches = 0;
  const app = await createApp({
    port: 7373,
    token: "admission-fixture",
    dataDir: join(f.root, "server-state"),
    fetchTransport: async () => {
      fetches++;
    },
  });
  try {
    const headers = { host: "127.0.0.1:7373", origin: "http://127.0.0.1:7373" };
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token: "admission-fixture" },
    });
    const auth = {
      ...headers,
      cookie: session.headers["set-cookie"]!.toString().split(";")[0]!,
    };
    const registration = await app.inject({
      method: "POST",
      url: "/api/repositories",
      headers: auth,
      payload: { path: f.repoRoot },
    });
    expect(registration.statusCode).toBe(200);
    const id = registration.json().id;
    await rename(f.repoRoot, f.repoRoot + "-admitted");
    execFileSync("git", [
      "clone",
      "--no-hardlinks",
      "-q",
      f.repoRoot + "-admitted",
      f.repoRoot,
    ]);
    const status = await app.inject({
      url: `/api/repositories/${id}/sync`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().available).toBe(false);
    const fetched = await app.inject({
      method: "POST",
      url: `/api/repositories/${id}/fetch-all`,
      headers: auth,
      payload: {},
    });
    expect(fetched.statusCode).toBe(409);
    expect(fetches).toBe(0);
  } finally {
    await app.close();
  }
});

test("admission identity comes from the saved physical authorization, not later live paths", async () => {
  const f = await fixture();
  const admitted = f.registration.expectedPhysicalIdentity(f.repo);
  expect(JSON.parse(admitted!)).toHaveLength(3);
  await rename(f.repoRoot, f.repoRoot + "-saved");
  execFileSync("git", [
    "clone",
    "--no-hardlinks",
    "-q",
    f.repoRoot + "-saved",
    f.repoRoot,
  ]);
  expect(f.registration.expectedPhysicalIdentity(f.repo)).toBe(admitted);
  expect(
    f.registration.expectedPhysicalIdentity({
      ...f.repo,
      gitDir: f.repo.gitDir + "-other",
    }),
  ).toBeNull();
});
