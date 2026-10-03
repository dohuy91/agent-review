import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  Repository,
  ReviewMode,
  ReviewObservation,
  ReviewFile,
  ReviewHistoryEntry,
  BranchesResponse,
} from "../../shared/src/index.js";
import { fingerprint } from "../../review/src/fingerprint.js";
import { git, gitText, readWorktree, safeStat } from "./git.js";
import {
  validateBase,
  registerRepository,
} from "../../../apps/server/src/registry.js";
export class StaleReviewError extends Error {
  statusCode = 409;
  constructor() {
    super("Review observation is stale; refresh required");
  }
}
const modes = ["branch", "working", "staged", "full"];
type LineCounts = { addedLines: number | null; deletedLines: number | null };
function parseNumstat(buffer: Buffer): Map<string, LineCounts> {
  const records = buffer.toString("utf8").split("\0");
  const counts = new Map<string, LineCounts>();
  for (let i = 0; i < records.length && records[i];) {
    const record = records[i++]!;
    // Paths may contain tabs and newlines. Only the first two tabs delimit
    // counters; -z emits renames as an empty path followed by two NUL paths.
    const first = record.indexOf("\t"),
      second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    let path = record.slice(second + 1);
    if (!path) {
      i++; // Original rename/copy path.
      path = records[i++] ?? "";
    }
    if (!path) continue;
    const added = record.slice(0, first),
      deleted = record.slice(first + 1, second);
    const numeric =
      /^\d+$/.test(added) &&
      /^\d+$/.test(deleted) &&
      Number.isSafeInteger(Number(added)) &&
      Number.isSafeInteger(Number(deleted));
    counts.set(path, {
      addedLines: numeric ? Number(added) : null,
      deletedLines: numeric ? Number(deleted) : null,
    });
  }
  return counts;
}
async function currentRepository(repo: Repository): Promise<Repository> {
  try {
    // Resolve identity through the same safe Git boundary used at registration.
    // Identical endpoints do not authorize a rebound Git directory/worktree.
    const current = await registerRepository(repo.root);
    if (
      (await realpath(repo.root)) !== repo.root ||
      (["root", "gitDir", "commonDir", "id", "projectId"] as const).some(
        (key) => current[key] !== repo[key],
      )
    )
      throw new StaleReviewError();
    return current;
  } catch {
    throw new StaleReviewError();
  }
}
async function localTarget(repo: Repository, target: string): Promise<string> {
  if (!target.startsWith("refs/heads/") || target.length > 4096)
    throw new Error("Target must be an exact local branch ref");
  await git(repo.root, ["check-ref-format", target]);
  const refs = (
    await gitText(repo.root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
      target,
    ])
  )
    .split("\n")
    .map((line) => line.split("\0"));
  const ref = refs.find(([name]) => name === target);
  // Do not accept rev expressions, ambiguous shorthand, or symbolic local aliases.
  if (
    !ref ||
    ref[2] !== "commit" ||
    ref[3] ||
    !/^[0-9a-f]{40,64}$/.test(ref[1]!)
  )
    throw new Error("Target must be an existing direct local branch");
  return ref[1]!;
}
async function observe(
  repo: Repository,
  base: string,
  mode: ReviewMode,
  targetRef?: string,
  historic?: Pick<
    ReviewHistoryEntry,
    "head" | "mergeBase" | "branch" | "targetRef" | "baseRef" | "worktree"
  >,
  includeCounts = true,
): Promise<Omit<ReviewObservation, "id">> {
  const current = await currentRepository(repo);
  if (!modes.includes(mode)) throw new Error("Invalid review mode");
  const head =
    historic?.head ??
    (targetRef === undefined
      ? current.head
      : await localTarget(repo, targetRef));
  const branch = historic ? historic.branch : (targetRef ?? current.branch);
  const worktree = historic?.worktree ?? {
    head: current.head,
    branch: current.branch,
  };
  const executionEligible =
    !historic && branch === current.branch && head === current.head;
  if (
    !historic &&
    mode !== "branch" &&
    targetRef !== undefined &&
    !executionEligible
  )
    throw new Error(
      "Mutable review modes require the checked-out target branch",
    );
  if (historic) {
    if (
      mode !== "branch" ||
      ![historic.head, historic.mergeBase, base].every((oid) =>
        /^[0-9a-f]{40,64}$/.test(oid),
      )
    )
      throw new StaleReviewError();
    await git(repo.root, ["cat-file", "-e", `${historic.head}^{commit}`]);
    await git(repo.root, ["cat-file", "-e", `${historic.mergeBase}^{commit}`]);
  }
  // The original base remains immutable metadata; only the stored comparison
  // endpoints are needed to reconstruct a historic branch comparison.
  const resolved = historic ? base : await validateBase(repo.root, base);
  const mergeBase =
    historic?.mergeBase ??
    (await gitText(repo.root, ["merge-base", resolved, head]));
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--raw",
    "--no-abbrev",
    "-z",
    "--find-renames",
  ];
  if (mode === "branch") args.push(mergeBase, head);
  if (mode === "staged") args.push("--cached", head);
  if (mode === "full") args.push(mergeBase);
  args.push("--");
  const raw = (await git(repo.root, args)).toString("utf8").split("\0");
  const files: ReviewFile[] = [];
  for (let i = 0; i < raw.length && raw[i];) {
    const meta = raw[i++]!;
    const [oldMode, newMode, oldOid, newOid, status] = meta.slice(1).split(" ");
    const first = raw[i++]!;
    const rename = status!.startsWith("R") || status!.startsWith("C");
    const path = rename ? raw[i++]! : first;
    files.push({
      path,
      oldPath: rename ? first : null,
      status: status!.slice(0, 1),
      kind:
        status === "U"
          ? "conflict"
          : oldMode === "160000" || newMode === "160000"
            ? "submodule"
            : oldMode === "120000" || newMode === "120000"
              ? "symlink"
              : "text",
      fingerprint: "",
      oldOid: /^0+$/.test(oldOid!) ? null : oldOid!,
      newOid: /^0+$/.test(newOid!) ? null : newOid!,
      oldMode: oldMode!,
      newMode: newMode!,
    });
  }
  if (mode === "working" || mode === "full") {
    // Tree-to-worktree diffs can report an unmerged path as M/D (or omit it)
    // rather than U. The actual index, not marker text, owns conflict membership.
    const unmerged = new Set(
      (await git(repo.root, ["ls-files", "--unmerged", "-z"]))
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((record) => record.slice(record.indexOf("\t") + 1)),
    );
    for (let i = files.length - 1; i >= 0; i--)
      if (unmerged.has(files[i]!.path)) files.splice(i, 1);
    for (const path of unmerged)
      files.push({
        path,
        oldPath: null,
        status: "U",
        kind: "conflict",
        fingerprint: "",
        // An unmerged index has no single old/new blob endpoint. Its only
        // displayable source is the separately guarded mutable worktree text.
        oldOid: null,
        newOid: null,
        oldMode: "000000",
        newMode: "000000",
      });
    const untracked = (
      await git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const path of untracked)
      if (!files.some((f) => f.path === path))
        files.push({
          path,
          oldPath: null,
          status: "A",
          kind: "text",
          fingerprint: "",
          oldOid: null,
          newOid: null,
          oldMode: "000000",
          newMode: "100644",
        });
  }
  for (let i = files.length - 1; i >= 0; i--) {
    if (
      files[i]!.kind !== "conflict" &&
      files.some((f) => f.path === files[i]!.path && f.kind === "conflict")
    )
      files.splice(i, 1);
  }
  const mutable = mode !== "branch";
  let index = "";
  if (mutable)
    index = (await git(repo.root, ["ls-files", "--stage", "-z"])).toString(
      "utf8",
    );
  index = fingerprint(index);
  const stats: unknown[] = [];
  if (files.length > 5000) throw new Error("Review exceeds file limit");
  for (const f of files) {
    let statIdentity: unknown = null;
    if (mode === "working" || mode === "full") {
      try {
        const s = await safeStat(repo.root, f.path);
        if (s) {
          statIdentity = [
            String(s.dev),
            String(s.ino),
            String(s.size),
            String(s.mtimeNs),
            String(s.ctimeNs),
            String(s.mode),
          ];
          if (s.isSymbolicLink() && f.kind !== "conflict") f.kind = "symlink";
          else if (
            !s.isFile() &&
            f.kind !== "submodule" &&
            f.kind !== "conflict"
          )
            f.kind = "unsupported";
        }
      } catch {
        if (f.kind !== "conflict") f.kind = "unsupported";
        statIdentity = "unsafe";
      }
    }
    stats.push([f.path, statIdentity]);
    f.fingerprint = fingerprint([
      mode,
      mergeBase,
      head,
      f,
      index,
      statIdentity,
      ...(targetRef === undefined ? [] : [targetRef]),
    ]);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // Keep display-only counters out of all existing file/review identities so
  // previously accepted marks, comments, and historical snapshots remain valid.
  const observationFingerprint = fingerprint([
    repo.id,
    mode,
    resolved,
    mergeBase,
    head,
    branch,
    files,
    index,
    stats,
    ...(targetRef === undefined ? [] : [targetRef]),
  ]);
  if (includeCounts) {
    const counts = parseNumstat(
      await git(
        repo.root,
        args.map((arg) => (arg === "--raw" ? "--numstat" : arg)),
      ),
    );
    for (const file of files) {
      let count: LineCounts = { addedLines: null, deletedLines: null };
      if (file.kind === "text") {
        count = counts.get(file.path) ?? count;
        if (
          !counts.has(file.path) &&
          file.status === "A" &&
          !file.oldOid &&
          !file.newOid &&
          (mode === "working" || mode === "full")
        ) {
          try {
            const content = await readWorktree(repo.root, file.path);
            if (content && !content.includes(0)) {
              let lines = 0;
              for (const byte of content) if (byte === 10) lines++;
              if (content.length && content.at(-1) !== 10) lines++;
              count = { addedLines: lines, deletedLines: 0 };
            }
          } catch {
            // Unsafe/non-regular/oversized sources have no displayable counters.
          }
        }
      }
      Object.assign(file, count);
    }
  }
  return {
    repositoryId: repo.id,
    base: resolved,
    mergeBase,
    head,
    branch,
    ...(targetRef === undefined ? {} : { targetRef }),
    ...(historic
      ? historic.baseRef === undefined
        ? {}
        : { baseRef: historic.baseRef }
      : { baseRef: base }),
    worktree,
    executionEligible,
    mode,
    files,
    fingerprint: observationFingerprint,
  };
}
export async function getReview(
  repo: Repository,
  base: string,
  mode: ReviewMode,
  target?: string,
): Promise<ReviewObservation> {
  const first = await observe(repo, base, mode, target, undefined, false);
  const second = await observe(repo, base, mode, target);
  if (first.fingerprint !== second.fingerprint) throw new StaleReviewError();
  return { ...second, id: randomUUID() };
}
export async function validateObservation(
  repo: Repository,
  observation: ReviewObservation,
) {
  try {
    if (
      repo.id !== observation.repositoryId ||
      (
        await observe(
          repo,
          observation.historical
            ? observation.base
            : (observation.baseRef ?? observation.base),
          observation.mode,
          observation.targetRef,
          observation.historical ? observation : undefined,
          false,
        )
      ).fingerprint !== observation.fingerprint
    )
      throw new StaleReviewError();
  } catch {
    // A previously valid endpoint that cannot be observed is stale as well.
    // Never expose Git/process diagnostics through this validation route.
    throw new StaleReviewError();
  }
}
export async function getBranches(repo: Repository): Promise<BranchesResponse> {
  const current = (await currentRepository(repo)).branch;
  const refs = (
    await gitText(repo.root, [
      "for-each-ref",
      "--format=%(refname)%00%(symref)",
      "refs/heads/",
      "refs/remotes/",
    ])
  )
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([ref, symbolic]) => !!ref && !symbolic)
    .map(([ref]) => ref!);
  const localBranches = refs.filter((ref) => ref.startsWith("refs/heads/"));
  const remoteBranches = refs.filter((ref) => ref.startsWith("refs/remotes/"));
  return {
    branches: localBranches,
    localBranches,
    remoteBranches,
    current,
  };
}

export async function getHistoricalReview(
  repo: Repository,
  entry: ReviewHistoryEntry,
): Promise<ReviewObservation> {
  if (entry.repositoryId !== repo.id || entry.mode !== "branch")
    throw new StaleReviewError();
  try {
    const observation = await observe(
      repo,
      entry.base,
      "branch",
      entry.targetRef,
      entry,
    );
    if (observation.fingerprint !== entry.fingerprint)
      throw new StaleReviewError();
    for (const f of observation.files)
      for (const [oid, mode] of [
        [f.oldOid, f.oldMode],
        [f.newOid, f.newMode],
      ])
        // Gitlinks describe another repository. Never fetch or require its
        // commits locally; retain their metadata with source display disabled.
        if (oid && mode !== "160000")
          await git(repo.root, ["cat-file", "-e", `${oid}^{blob}`]);
    return { ...observation, id: randomUUID(), historical: true };
  } catch {
    throw new StaleReviewError();
  }
}
