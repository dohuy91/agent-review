import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRepository } from "../apps/server/src/registry.js";
import {
  getHistoricalReview,
  getReview,
  validateObservation,
} from "../packages/git/src/review.js";
import * as gitBoundary from "../packages/git/src/git.js";
import { fingerprint } from "../packages/review/src/fingerprint.js";
import { DISPLAY_LIMIT } from "../packages/git/src/git.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("fingerprint-only validation avoids collecting display line counts again", async () => {
  const { root, git, repo } = await fixture();
  await writeFile(join(root, "a.txt"), "keep\nchanged\n");
  git("commit", "-qam", "change");
  const review = await getReview(repo, "base", "branch");
  const original = gitBoundary.git,
    commands: string[][] = [];
  vi.spyOn(gitBoundary, "git").mockImplementation(async (root, args) => {
    commands.push(args);
    return original(root, args);
  });
  await validateObservation(repo, review);
  expect(commands.some((args) => args.includes("--numstat"))).toBe(false);
  expect(commands.some((args) => args.includes("--raw"))).toBe(true);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-counts-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(root, "a.txt"), "keep\nbase\nremove\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("branch", "base");
  return { root, git, repo: await registerRepository(root) };
}

test("line counts use the exact branch, staged, working, and full endpoints", async () => {
  const { root, git, repo } = await fixture();
  await writeFile(join(root, "a.txt"), "keep\ncommitted\nbranch extra\n");
  git("commit", "-qam", "branch");
  await writeFile(
    join(root, "a.txt"),
    "keep\nstaged\nstaged extra\nstaged second\n",
  );
  git("add", "a.txt");
  await writeFile(join(root, "a.txt"), "keep\nworking\n");
  for (const [mode, addedLines, deletedLines] of [
    ["branch", 2, 2],
    ["staged", 3, 2],
    ["working", 1, 3],
    ["full", 1, 2],
  ] as const) {
    const review = await getReview(repo, "base", mode);
    expect(review.files[0]).toMatchObject({
      path: "a.txt",
      addedLines,
      deletedLines,
    });
  }
});

test("non-HEAD branch counts follow the selected target without reading its checkout", async () => {
  const { root, git, repo } = await fixture();
  git("checkout", "-qb", "feature/topic");
  await writeFile(join(root, "a.txt"), "keep\nfeature\nextra\nsecond\n");
  git("commit", "-qam", "feature");
  git("checkout", "-q", "main");
  await writeFile(join(root, "a.txt"), "main worktree\n");
  const review = await getReview(
    repo,
    "base",
    "branch",
    "refs/heads/feature/topic",
  );
  expect(review.files[0]).toMatchObject({ addedLines: 3, deletedLines: 2 });
  expect(review.targetRef).toBe("refs/heads/feature/topic");
  expect(git("branch", "--show-current")).toBe("main");
});

test("NUL numstat records preserve rename, Unicode, tab, newline, deletion and binary paths", async () => {
  const { root, git, repo } = await fixture();
  await mkdir(join(root, "目录"));
  const before = "目录/old\tname\n.txt",
    next = "目录/new\tname\n.txt";
  await writeFile(join(root, before), "one\ntwo\nthree\nfour\nfive\n");
  await writeFile(join(root, "deleted.txt"), "delete one\ndelete two\n");
  git("add", ".");
  git("commit", "-qm", "names");
  git("branch", "names");
  await rename(join(root, before), join(root, next));
  await writeFile(join(root, next), "one\ntwo\nchanged\nfour\nfive\nadded\n");
  await rm(join(root, "deleted.txt"));
  await writeFile(join(root, "binary\n文件"), Buffer.from([0, 1, 2]));
  git("add", "-A");
  git("commit", "-qm", "changes");
  const review = await getReview(repo, "names", "branch");
  expect(review.files.find((file) => file.path === next)).toMatchObject({
    oldPath: before,
    status: "R",
    addedLines: 2,
    deletedLines: 1,
  });
  expect(
    review.files.find((file) => file.path === "deleted.txt"),
  ).toMatchObject({ addedLines: 0, deletedLines: 2 });
  expect(
    review.files.find((file) => file.path === "binary\n文件"),
  ).toMatchObject({ addedLines: null, deletedLines: null });
});

test("untracked text counts follow display bounds and never dereference source outside the root", async () => {
  const { root, repo } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "review-counts-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "secret"), "outside secret\nnot reviewed\n");
  await writeFile(join(root, "new\t文件\n.txt"), "new one\nnew two");
  await writeFile(join(root, "empty"), "");
  await writeFile(join(root, "binary"), Buffer.from([0, 10, 1]));
  await writeFile(join(root, "large"), "x".repeat(DISPLAY_LIMIT + 1));
  await symlink(join(outside, "secret"), join(root, "link"));
  await symlink(outside, join(root, "outside"));
  for (const mode of ["working", "full"] as const) {
    const review = await getReview(repo, "base", mode);
    expect(
      review.files.find((file) => file.path === "new\t文件\n.txt"),
    ).toMatchObject({ addedLines: 2, deletedLines: 0 });
    expect(review.files.find((file) => file.path === "empty")).toMatchObject({
      addedLines: 0,
      deletedLines: 0,
    });
    for (const path of ["binary", "large", "link", "outside"]) {
      expect(review.files.find((file) => file.path === path)).toMatchObject({
        addedLines: null,
        deletedLines: null,
      });
    }
    expect(JSON.stringify(review)).not.toContain("outside secret");
    expect(review.files.some((file) => file.path === "outside/secret")).toBe(
      false,
    );
  }
});

test("display counts preserve legacy fingerprints and reconstructed historical branch observations", async () => {
  const { root, git, repo } = await fixture();
  await writeFile(join(root, "a.txt"), "keep\nchanged\n");
  git("commit", "-qam", "change");
  const review = await getReview(repo, "base", "branch");
  const legacyFiles = review.files.map(
    ({ addedLines, deletedLines, ...file }) => file,
  );
  const index = fingerprint("");
  const file = legacyFiles[0]!;
  expect(file.fingerprint).toBe(
    fingerprint([
      "branch",
      review.mergeBase,
      review.head,
      { ...file, fingerprint: "" },
      index,
      null,
    ]),
  );
  expect(review.fingerprint).toBe(
    fingerprint([
      repo.id,
      "branch",
      review.base,
      review.mergeBase,
      review.head,
      review.branch,
      legacyFiles,
      index,
      [[file.path, null]],
    ]),
  );
  const historical = await getHistoricalReview(repo, {
    ...review,
    acceptedAt: "2026-10-03T00:00:00Z",
    fileCount: 1,
    historicalContent: "git-objects-only",
  });
  expect(historical.fingerprint).toBe(review.fingerprint);
  expect(historical.files[0]).toMatchObject({ addedLines: 1, deletedLines: 2 });
});
