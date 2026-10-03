import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRepository } from "../apps/server/src/registry.js";
import { getReview } from "../packages/git/src/review.js";
import { getFileDiff } from "../packages/git/src/diff.js";
import { DISPLAY_LIMIT } from "../packages/git/src/git.js";
import { ReviewStore } from "../packages/review/src/store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(path = "a.txt") {
  const root = await mkdtemp(join(tmpdir(), "conflict-display-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  await writeFile(join(root, path), "before\nbase\nafter\n");
  git("add", "--", path);
  git("commit", "-qm", "base");
  git("branch", "base");
  git("checkout", "-qb", "side");
  await writeFile(join(root, path), "before\ntheirs\nafter\n");
  git("commit", "-qam", "side");
  git("checkout", "-q", "main");
  await writeFile(join(root, path), "before\nours\nafter\n");
  git("commit", "-qam", "ours");
  expect(() => git("merge", "side")).toThrow();
  expect(git("ls-files", "--unmerged", "--", path)).not.toBe("");
  return { root, path, git, repo: await registerRepository(root) };
}

for (const mode of ["working", "full"] as const) {
  test(`${mode} conflict source has exact new-side lines and never invents an old endpoint`, async () => {
    const { root, path, git, repo } = await fixture();
    const indexBefore = await readFile(join(repo.gitDir, "index"));
    const headBefore = git("rev-parse", "HEAD");
    const review = await getReview(repo, "base", mode);
    expect(review.files).toHaveLength(1);
    expect(review.files[0]).toMatchObject({
      path,
      kind: "conflict",
      status: "U",
      oldOid: null,
      newOid: null,
      addedLines: null,
      deletedLines: null,
    });
    const diff = await getFileDiff(repo, review, path);
    expect(diff.unsupportedReason).toBeNull();
    expect(diff.oldContent).toBeNull();
    expect(diff.newContent).toBe(
      "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nafter\n",
    );
    expect(diff.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(diff.hunks).toEqual([
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 7,
        lines: [
          { type: "add", text: "before", oldLine: null, newLine: 1 },
          { type: "add", text: "<<<<<<< HEAD", oldLine: null, newLine: 2 },
          { type: "add", text: "ours", oldLine: null, newLine: 3 },
          { type: "add", text: "=======", oldLine: null, newLine: 4 },
          { type: "add", text: "theirs", oldLine: null, newLine: 5 },
          { type: "add", text: ">>>>>>> side", oldLine: null, newLine: 6 },
          { type: "add", text: "after", oldLine: null, newLine: 7 },
        ],
      },
    ]);
    expect(await readFile(join(repo.gitDir, "index"))).toEqual(indexBefore);
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
    expect(await readFile(join(root, path), "utf8")).toBe(diff.newContent);
  });
}

test("full inventory keeps unmerged entries even when worktree text equals the comparison base", async () => {
  const { root, path, git, repo } = await fixture("odd\tname\n.txt");
  await writeFile(join(root, path), "before\nbase\nafter\n");
  expect(git("diff", "--name-only", "base", "--", path)).toBe("");
  const review = await getReview(repo, "base", "full");
  expect(review.files).toHaveLength(1);
  expect(review.files[0]).toMatchObject({
    path,
    kind: "conflict",
    status: "U",
    oldOid: null,
    newOid: null,
  });
  expect((await getFileDiff(repo, review, path)).newContent).toBe(
    "before\nbase\nafter\n",
  );
});

test("edited markers invalidate lazy source and remain conflicted until external git add", async () => {
  const { root, path, git, repo } = await fixture();
  const review = await getReview(repo, "base", "working");
  await writeFile(join(root, path), "before\nresolved manually\nafter");
  await expect(getFileDiff(repo, review, path)).rejects.toMatchObject({
    statusCode: 409,
  });
  const fresh = await getReview(repo, "base", "working");
  expect(fresh.files[0]).toMatchObject({ kind: "conflict", status: "U" });
  const diff = await getFileDiff(repo, fresh, path);
  expect(diff.newContent).toBe("before\nresolved manually\nafter");
  expect(diff.hunks[0]!.lines.map((line) => line.newLine)).toEqual([1, 2, 3]);
  git("add", "--", path);
  await expect(getFileDiff(repo, fresh, path)).rejects.toMatchObject({
    statusCode: 409,
  });
  const staged = await getReview(repo, "base", "full");
  expect(staged.files[0]).toMatchObject({ kind: "text", status: "M" });
  expect((await getFileDiff(repo, staged, path)).newContent).toBe(
    "before\nresolved manually\nafter",
  );
});

test("conflict comments use real new-side hashes and reject the absent old side", async () => {
  const { path, repo } = await fixture();
  const review = await getReview(repo, "base", "full");
  const diff = await getFileDiff(repo, review, path);
  const data = await mkdtemp(join(tmpdir(), "conflict-comments-"));
  roots.push(data);
  const store = new ReviewStore(data);
  const input = {
    reviewId: review.id,
    path,
    side: "new" as const,
    startLine: 3,
    endLine: 3,
    body: "Preserve this behavior",
    severity: "info" as const,
  };
  try {
    const comment = store.create(repo, review, diff, input);
    expect(comment.sourceOid).toBeNull();
    expect(comment.anchor.selected).toEqual([
      createHash("sha256").update("ours").digest("hex"),
    ]);
    expect(() =>
      store.create(repo, review, diff, { ...input, side: "old" }),
    ).toThrow(/invalid/i);
    expect(() =>
      store.create(repo, review, diff, { ...input, startLine: 8, endLine: 8 }),
    ).toThrow(/invalid/i);
  } finally {
    store.close();
  }
});

test("staged conflicts withhold worktree text while branch review stays immutable", async () => {
  const { root, path, repo } = await fixture();
  await writeFile(join(root, path), "uncommitted conflict secret\n");
  const staged = await getReview(repo, "base", "staged");
  expect(staged.files[0]!.kind).toBe("conflict");
  expect(await getFileDiff(repo, staged, path)).toMatchObject({
    oldContent: null,
    newContent: null,
    hunks: [],
    contentFingerprint: null,
    unsupportedReason: expect.stringMatching(/conflict/i),
  });
  const branch = await getReview(repo, "base", "branch");
  expect(branch.files[0]!.kind).toBe("text");
  const diff = await getFileDiff(repo, branch, path);
  expect(diff.oldContent).toBe("before\nbase\nafter\n");
  expect(diff.newContent).toBe("before\nours\nafter\n");
});

for (const [label, content, reason] of [
  ["binary", Buffer.from([65, 0, 66]), /binary/i],
  ["malformed UTF-8", Buffer.from([65, 0xc3, 0x28, 66]), /safely displayed/i],
  ["oversized", Buffer.alloc(DISPLAY_LIMIT + 1, 65), /limit/i],
] as const) {
  test(`${label} conflict source is withheld without hiding unmerged membership`, async () => {
    const { root, path, repo } = await fixture();
    await writeFile(join(root, path), content);
    const review = await getReview(repo, "base", "full");
    expect(review.files[0]).toMatchObject({ kind: "conflict", status: "U" });
    expect(await getFileDiff(repo, review, path)).toMatchObject({
      oldContent: null,
      newContent: null,
      hunks: [],
      contentFingerprint: null,
      unsupportedReason: expect.stringMatching(reason),
    });
  });
}

test("a symlink conflict retains unmerged membership without disclosing the link target", async () => {
  const { root, path, repo } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "conflict-secret-"));
  roots.push(outside);
  await writeFile(join(outside, "secret"), "outside secret\n");
  await rm(join(root, path));
  await symlink(join(outside, "secret"), join(root, path));
  const review = await getReview(repo, "base", "working");
  expect(review.files[0]).toMatchObject({ kind: "conflict", status: "U" });
  expect(await getFileDiff(repo, review, path)).toMatchObject({
    oldContent: null,
    newContent: null,
    hunks: [],
    unsupportedReason: expect.any(String),
  });
});

test("a missing conflict worktree file has no displayable endpoint", async () => {
  const { root, path, repo } = await fixture();
  await rm(join(root, path));
  const review = await getReview(repo, "base", "full");
  expect(review.files[0]).toMatchObject({ kind: "conflict", status: "U" });
  expect(await getFileDiff(repo, review, path)).toMatchObject({
    oldContent: null,
    newContent: null,
    hunks: [],
    contentFingerprint: null,
    unsupportedReason: expect.any(String),
  });
});
