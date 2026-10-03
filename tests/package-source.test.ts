import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/package-source.mjs");
const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-package-"));
  owned.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  for (const [name, text] of Object.entries({
    "README.md": "portable source\n",
    "apps/example.ts": "export const value = 1;\n",
    "docs/superpowers/plan.md": "private coordination\n",
    ".superpowers/report.md": "private notes\n",
    "state/review.sqlite": "synthetic state\n",
    ".env.local": "SYNTHETIC=test\n",
    "node_modules/fake/index.js": "synthetic dependency\n",
    "apps/web/dist/index.html": "generated output\n",
  })) {
    const path = join(repo, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  git("add", "-A");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  return { root, repo };
}
it("packages committed portable sources without tracked notes, state, secrets, dependencies or output", () => {
  const { root, repo } = fixture(),
    output = join(root, "source.tar.gz");
  writeFileSync(join(repo, "README.md"), "uncommitted change\n");
  const result = spawnSync(process.execPath, [script, output], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const names = execFileSync("tar", ["-tzf", output], { encoding: "utf8" })
    .split("\n")
    .filter((p) => p && !p.endsWith("/"));
  expect(names.sort()).toEqual(["README.md", "apps/example.ts"]);
  expect(
    execFileSync("tar", ["-xOzf", output, "README.md"], { encoding: "utf8" }),
  ).toBe("portable source\n");
});
it("refuses existing outputs and outputs inside the source repository", () => {
  const { root, repo } = fixture(),
    output = join(root, "existing.tar.gz");
  writeFileSync(output, "keep me");
  expect(
    spawnSync(process.execPath, [script, output], { cwd: repo }).status,
  ).toBe(1);
  expect(readFileSync(output, "utf8")).toBe("keep me");
  expect(
    spawnSync(process.execPath, [script, join(repo, "source.tar.gz")], {
      cwd: repo,
    }).status,
  ).toBe(1);
});
