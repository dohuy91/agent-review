import { afterEach, expect, test } from "vitest";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRepository } from "../apps/server/src/registry.js";
import { installGitActionRoutes } from "../apps/server/src/routes/git-actions.js";
import type { ReviewAccess } from "../apps/server/src/routes/reviews.js";
const roots: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-comparison-map-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "a"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  const oid = git("rev-parse", "HEAD");
  const repo = await registerRepository(root);
  const app = Fastify();
  apps.push(app);
  let networkCalls = 0;
  installGitActionRoutes(app, new Map([[repo.id, repo]]), {} as ReviewAccess, {
    fetchTransport: async () => {
      networkCalls++;
    },
  });
  const read = async () => {
    const response = await app.inject({
      url: `/api/repositories/${repo.id}/remotes`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(networkCalls).toBe(0);
    return response.json().comparisonDestinations;
  };
  const remote = (name: string, specs: string[]) => {
    git("remote", "add", name, `https://${name}.example.test/repo.git`);
    git("config", "--unset-all", `remote.${name}.fetch`);
    for (const spec of specs)
      git("config", "--add", `remote.${name}.fetch`, spec);
  };
  const tracking = (ref: string) => git("update-ref", ref, oid);
  return { git, read, remote, tracking };
}
test("offline metadata inverts exact renamed and wildcard mappings for live slash-containing refs across remotes", async () => {
  const f = await fixture();
  f.remote("origin", ["+refs/heads/release:refs/remotes/origin/main"]);
  f.remote("upstream", ["+refs/heads/topic/*:refs/remotes/upstream/review/*"]);
  f.tracking("refs/remotes/origin/main");
  f.tracking("refs/remotes/upstream/review/very/long/topic");
  f.tracking("refs/remotes/origin/unmapped");
  f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  expect(await f.read()).toEqual([
    {
      trackingRef: "refs/remotes/origin/main",
      remote: "origin",
      destinationRef: "refs/heads/release",
    },
    {
      trackingRef: "refs/remotes/upstream/review/very/long/topic",
      remote: "upstream",
      destinationRef: "refs/heads/topic/very/long/topic",
    },
  ]);
});
test("offline metadata omits ambiguous, negative-excluded and unsupported mappings", async () => {
  const f = await fixture();
  f.remote("origin", [
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/heads/release:refs/remotes/origin/main",
  ]);
  f.remote("excluded", [
    "+refs/heads/*:refs/remotes/excluded/*",
    "^refs/heads/private/*",
  ]);
  f.remote("unsupported", [
    "+refs/heads/*:refs/remotes/unsupported/*",
    "+refs/tags/*:refs/remotes/unsupported/tags/*",
  ]);
  for (const ref of [
    "refs/remotes/origin/main",
    "refs/remotes/excluded/private/one",
    "refs/remotes/excluded/public/one",
    "refs/remotes/unsupported/main",
  ])
    f.tracking(ref);
  expect(await f.read()).toEqual([
    {
      trackingRef: "refs/remotes/excluded/public/one",
      remote: "excluded",
      destinationRef: "refs/heads/public/one",
    },
  ]);
});

test("tracking refs mapped by another configured remote are ambiguous even when its namespace differs", async () => {
  const f = await fixture();
  f.remote("origin", ["+refs/heads/*:refs/remotes/origin/*"]);
  f.remote("other", ["+refs/heads/release:refs/remotes/origin/main"]);
  f.tracking("refs/remotes/origin/main");
  expect(await f.read()).toEqual([]);
});

test("an unsupported configured source that writes the same tracking ref blocks a supported mapping", async () => {
  const f = await fixture();
  f.remote("origin", ["+refs/heads/*:refs/remotes/origin/*"]);
  f.remote("other", ["+refs/tags/release:refs/remotes/origin/main"]);
  f.tracking("refs/remotes/origin/main");
  expect(await f.read()).toEqual([]);
});

test("wildcard captures retain literal dollar replacement syntax in branch names", async () => {
  const f = await fixture();
  f.remote("origin", ["+refs/heads/*:refs/remotes/origin/*"]);
  const branch = "topic/$`/$&/$'";
  f.tracking(`refs/remotes/origin/${branch}`);
  expect(await f.read()).toEqual([
    {
      trackingRef: `refs/remotes/origin/${branch}`,
      remote: "origin",
      destinationRef: `refs/heads/${branch}`,
    },
  ]);
});
