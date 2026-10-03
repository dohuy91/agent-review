import type {
  Repository,
  ReviewObservation,
  FileDiff,
  DiffHunk,
} from "../../shared/src/index.js";
import { git, gitText, readWorktree, validPath, DISPLAY_LIMIT } from "./git.js";
import { validateObservation, StaleReviewError } from "./review.js";
import { fingerprint } from "../../review/src/fingerprint.js";
async function blob(repo: Repository, oid: string | null) {
  if (!oid) return null;
  const size = Number(await gitText(repo.root, ["cat-file", "-s", oid]));
  if (size > DISPLAY_LIMIT) throw new Error("File exceeds display limit");
  return git(repo.root, ["cat-file", "blob", oid]);
}
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let h: DiffHunk | undefined;
  let old = 0,
    newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      h = undefined;
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      old = Number(m[1]);
      newLine = Number(m[3]);
      h = {
        oldStart: old,
        oldCount: Number(m[2] ?? 1),
        newStart: newLine,
        newCount: Number(m[4] ?? 1),
        lines: [],
      };
      hunks.push(h);
    } else if (h && line.startsWith("+"))
      h.lines.push({
        type: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    else if (h && line.startsWith("-"))
      h.lines.push({
        type: "delete",
        text: line.slice(1),
        oldLine: old++,
        newLine: null,
      });
    else if (h && line.startsWith(" "))
      h.lines.push({
        type: "context",
        text: line.slice(1),
        oldLine: old++,
        newLine: newLine++,
      });
  }
  return hunks;
}
function newOnlyHunk(content: string): DiffHunk {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: lines.length,
    lines: lines.map((text, i) => ({
      type: "add",
      text,
      oldLine: null,
      newLine: i + 1,
    })),
  };
}
export async function getFileDiff(
  repo: Repository,
  observation: ReviewObservation,
  path: string,
): Promise<FileDiff> {
  validPath(path);
  await validateObservation(repo, observation);
  const f = observation.files.find((f) => f.path === path);
  if (!f) throw new Error("File is not in review");
  let result: FileDiff = {
    reviewId: observation.id,
    path,
    fingerprint: f.fingerprint,
    hunks: [],
    oldContent: null,
    newContent: null,
    unsupportedReason: null,
    contentFingerprint: null,
  };
  const conflict =
    f.kind === "conflict" &&
    (observation.mode === "working" || observation.mode === "full");
  if (f.kind !== "text" && !conflict)
    result.unsupportedReason = `${f.kind}: source display is unavailable`;
  else {
    try {
      const old = conflict ? null : await blob(repo, f.oldOid);
      const next =
        observation.mode === "working" || observation.mode === "full"
          ? await readWorktree(repo.root, path)
          : await blob(repo, f.newOid);
      if (conflict && next === null)
        throw new Error("Conflict worktree source is unavailable");
      if (old?.includes(0) || next?.includes(0))
        result.unsupportedReason = "Binary file: source display is unavailable";
      else {
        result.oldContent = old?.toString("utf8") ?? null;
        // Replacement characters would invent source and corrupt anchors.
        // Preserve an actual UTF-8 BOM while rejecting malformed bytes.
        result.newContent = conflict
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              next!,
            )
          : (next?.toString("utf8") ?? null);
        result.contentFingerprint = fingerprint([
          f.fingerprint,
          result.oldContent,
          result.newContent,
        ]);
        if (conflict) result.hunks = [newOnlyHunk(result.newContent!)];
        else {
          const args = [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
          ];
          if (observation.mode === "branch")
            args.push(observation.mergeBase, observation.head);
          if (observation.mode === "staged")
            args.push("--cached", observation.head);
          if (observation.mode === "full") args.push(observation.mergeBase);
          args.push("--", ...(f.oldPath ? [f.oldPath] : []), path);
          const patch = (await git(repo.root, args)).toString("utf8");
          result.hunks = parseHunks(patch);
          if (
            f.status === "A" &&
            !f.newOid &&
            (observation.mode === "working" || observation.mode === "full") &&
            !result.hunks.length &&
            result.newContent !== null
          )
            result.hunks = [newOnlyHunk(result.newContent)];
        }
      }
    } catch (e) {
      if (e instanceof StaleReviewError) throw e;
      result = {
        ...result,
        oldContent: null,
        newContent: null,
        hunks: [],
        contentFingerprint: null,
        unsupportedReason: /display limit/.test((e as Error).message)
          ? "File exceeds display limit"
          : "File cannot be safely displayed",
      };
    }
  }
  await validateObservation(repo, observation);
  return result;
}
