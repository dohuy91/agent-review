import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  Repository,
  ReviewMode,
  ReviewObservation,
  ReviewFile,
  ReviewHistoryEntry,
} from "../../shared/src/index.js";
import { fingerprint } from "../../review/src/fingerprint.js";
import { git, gitText, safeStat } from "./git.js";
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
async function observe(
  repo: Repository,
  base: string,
  mode: ReviewMode,
  historic?: Pick<ReviewHistoryEntry, "head" | "mergeBase" | "branch">,
): Promise<Omit<ReviewObservation, "id">> {
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
  } catch {
    throw new StaleReviewError();
  }
  if (!modes.includes(mode)) throw new Error("Invalid review mode");
  const head =
    historic?.head ??
    (await gitText(repo.root, ["rev-parse", "--verify", "HEAD^{commit}"]));
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
  let branch: null | string = null;
  try {
    branch = await gitText(repo.root, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch {}
  if (historic) branch = historic.branch;
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
          if (s.isSymbolicLink()) f.kind = "symlink";
          else if (!s.isFile() && f.kind !== "submodule")
            f.kind = "unsupported";
        }
      } catch {
        f.kind = "unsupported";
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
    ]);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    repositoryId: repo.id,
    base: resolved,
    mergeBase,
    head,
    branch,
    mode,
    files,
    fingerprint: fingerprint([
      repo.id,
      mode,
      resolved,
      mergeBase,
      head,
      branch,
      files,
      index,
      stats,
    ]),
  };
}
export async function getReview(
  repo: Repository,
  base: string,
  mode: ReviewMode,
): Promise<ReviewObservation> {
  const first = await observe(repo, base, mode);
  const second = await observe(repo, base, mode);
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
          observation.base,
          observation.mode,
          observation.historical ? observation : undefined,
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
export async function getBranches(repo: Repository) {
  let current: string | null = null;
  try {
    current = await gitText(repo.root, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch {}
  return {
    branches: (
      await gitText(repo.root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/",
      ])
    )
      .split("\n")
      .filter(Boolean),
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
    const observation = await observe(repo, entry.base, "branch", entry);
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
