import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRepository } from "../apps/server/src/registry.js";
import { fetchRemote, getRemotes } from "../packages/git/src/remotes.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-redirect-preflight-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "a"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  git("remote", "add", "origin", "https://fetch.example.test/repo.git");
  return { git, repo: await registerRepository(root), root };
}
test("offline Git URL matching demonstrates that a scoped redirect value overrides the generic false option", async () => {
  const f = await fixture();
  f.git("config", "http.https://fetch.example.test/.followRedirects", "true");
  expect(
    f.git(
      "-c",
      "http.followRedirects=false",
      "config",
      "--get-urlmatch",
      "http.followRedirects",
      "https://fetch.example.test/repo.git",
    ),
  ).toBe("true");
});
test("Fetch metadata and explicit preflight reject URL-scoped redirect overrides without contacting transport", async () => {
  const f = await fixture();
  let calls = 0;
  for (const value of ["true", "initial", "unknown", ""]) {
    f.git("config", "http.https://fetch.example.test/.followRedirects", value);
    const remote = (await getRemotes(f.repo))[0]!;
    expect(remote.fetchAvailable).toBe(false);
    expect(remote.reason).toMatch(/redirect/i);
    await expect(
      fetchRemote(f.repo, "origin", f.repo.head, async () => {
        calls++;
      }),
    ).rejects.toThrow(/redirect/i);
    expect(calls).toBe(0);
  }
});
test("false URL-scoped redirect aliases retain the fixed Fetch policy", async () => {
  const f = await fixture();
  let calls = 0;
  for (const value of ["false", "no", "off", "0", "FALSE"]) {
    f.git("config", "http.https://fetch.example.test/.followRedirects", value);
    expect((await getRemotes(f.repo))[0]!.fetchAvailable).toBe(true);
    await fetchRemote(f.repo, "origin", f.repo.head, async (_command, args) => {
      expect(args).toContain("http.followRedirects=false");
      calls++;
    });
  }
  expect(calls).toBe(5);
});
