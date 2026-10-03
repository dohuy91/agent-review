import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Repository,
  ReviewObservation,
  GitCommitResult,
} from "../../shared/src/index.js";
import { git, gitText } from "./git.js";
import { StaleReviewError } from "./review.js";
import {
  assertReviewFile,
  GitActionError,
  headEntry,
  indexEntries,
  indexInfo,
  regularEntry,
  validateIdentity,
  validateWriteDestinations,
  withIndexLock,
  withTemporaryIndex,
  writeGit,
  type Revalidate,
} from "./mutations.js";
async function branchIdentity(repo: Repository, o: ReviewObservation) {
  await validateIdentity(repo, o);
  if (!o.branch?.startsWith("refs/heads/"))
    throw new GitActionError("Select a local branch before committing");
  await validateWriteDestinations(repo, { objects: true, branch: o.branch });
  const path = join(repo.gitDir, "HEAD");
  const before = await lstat(path);
  if (!before.isFile())
    throw new GitActionError("Symbolic filesystem HEAD is not supported", 409);
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (
      s.ino !== before.ino ||
      s.dev !== before.dev ||
      (await h.readFile("utf8")) !== `ref: ${o.branch}\n`
    )
      throw new StaleReviewError();
  } finally {
    await h.close();
  }
  let symbolic = false;
  try {
    await git(repo.root, ["symbolic-ref", "--quiet", "--no-recurse", o.branch]);
    symbolic = true;
  } catch {}
  if (symbolic)
    throw new GitActionError(
      "Symbolic branch references are not supported",
      409,
    );
  // Ref writes must never follow filesystem symlinks, including ancestor directories.
  const ref = join(repo.commonDir, o.branch);
  let parent = dirname(ref);
  for (;;) {
    try {
      if ((await realpath(parent)) !== parent) throw new StaleReviewError();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      parent = dirname(parent);
    }
  }
  try {
    if (!(await lstat(ref)).isFile()) throw new StaleReviewError();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return o.branch;
}
export async function commitSelected(
  repo: Repository,
  o: ReviewObservation,
  paths: string[],
  message: string,
  revalidate: Revalidate,
): Promise<GitCommitResult> {
  return withIndexLock(repo, async (guard) => {
    await revalidate();
    const branch = await branchIdentity(repo, o);
    for (const key of ["user.name", "user.email"]) {
      let value = "";
      try {
        value = await gitText(repo.root, ["config", "--get", key]);
      } catch {}
      if (!value.trim() || /[\x00-\x1f<>]/.test(value))
        throw new GitActionError(
          "Configure your Git user.name and user.email identity before committing",
        );
    }
    const entries = await indexEntries(repo);
    if (entries.some((e) => e.stage !== 0))
      throw new GitActionError("Resolve index conflicts before committing");
    const selected: Buffer[] = [];
    let changed = false;
    for (const path of paths) {
      await assertReviewFile(repo, o, path);
      const entry = entries.find((e) => e.path === path) ?? null;
      regularEntry(entry);
      if (entry?.intentToAdd)
        throw new GitActionError(
          "Intent-to-add is not staged content; stage this file before committing",
        );
      const previous = await headEntry(repo, o.head, path);
      regularEntry(previous);
      if (entry?.oid !== previous?.oid || entry?.mode !== previous?.mode)
        changed = true;
      selected.push(indexInfo(path, entry, o.head.length));
    }
    if (!changed)
      throw new GitActionError(
        "Selected files have no staged changes to commit",
      );
    return withTemporaryIndex(repo, null, async (index) => {
      await writeGit(repo, ["read-tree", o.head], undefined, index);
      await writeGit(
        repo,
        ["update-index", "-z", "--index-info"],
        Buffer.concat(selected),
        index,
      );
      const tree = (await writeGit(repo, ["write-tree"], undefined, index))
        .toString("utf8")
        .trim();
      const commit = (
        await writeGit(
          repo,
          ["commit-tree", tree, "-p", o.head, "--no-gpg-sign", "-F", "-"],
          Buffer.from(message + "\n"),
          index,
        )
      )
        .toString("utf8")
        .trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit))
        throw new GitActionError("Unable to create commit");
      await revalidate();
      await guard.verify();
      await branchIdentity(repo, o);
      // CAS the exact direct branch, never HEAD. No force rollback if another writer won.
      try {
        await writeGit(repo, [
          "update-ref",
          "--no-deref",
          "-m",
          "agent-review: selected staged files",
          branch,
          commit,
          o.head,
        ]);
      } catch {
        throw new GitActionError(
          "Branch changed before commit publication; refresh before retrying",
          409,
        );
      }
      return { ok: true, changed: true, commit };
    });
  });
}
