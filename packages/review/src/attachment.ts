import type {
  Repository,
  ReviewObservation,
  ReviewComment,
  AttachedComment,
} from "../../shared/src/index.js";
import { attach, makeAnchor } from "./anchors.js";
import { getFileDiff } from "../../git/src/diff.js";
import { git } from "../../git/src/git.js";
export async function attachComment(
  repository: Repository,
  observation: ReviewObservation,
  comment: ReviewComment,
): Promise<AttachedComment> {
  let attachedRange = null;
  let attachedPath: string | null = null;
  const direct = observation.files.find((f) => f.path === comment.path);
  const renamed = observation.files.filter(
    (f) => f.oldPath === comment.path && f.status.startsWith("R"),
  );
  const file = direct ?? (renamed.length === 1 ? renamed[0] : undefined);
  if (
    file &&
    comment.worktreeRoot === repository.root &&
    comment.mode === observation.mode &&
    comment.base === observation.base &&
    comment.branch === observation.branch
  ) {
    const diff = await getFileDiff(repository, observation, file.path);
    const content = comment.side === "old" ? diff.oldContent : diff.newContent;
    if (
      content !== null &&
      comment.fileFingerprint === diff.fingerprint &&
      file.path === comment.path
    ) {
      try {
        if (
          JSON.stringify(
            makeAnchor(content, comment.startLine, comment.endLine),
          ) === JSON.stringify(comment.anchor)
        )
          attachedRange = {
            startLine: comment.startLine,
            endLine: comment.endLine,
          };
      } catch {}
    } else attachedRange = attach(comment.anchor, content);
    if (attachedRange) attachedPath = file.path;
  }
  let historicalContent: AttachedComment["historicalContent"] = "unavailable";
  if (comment.sourceOid && /^[0-9a-f]{40,64}$/.test(comment.sourceOid)) {
    try {
      await git(repository.root, [
        "cat-file",
        "-e",
        `${comment.sourceOid}^{blob}`,
      ]);
      historicalContent = "available";
    } catch {}
  }
  return {
    ...comment,
    attachment: attachedRange ? "current" : "outdated",
    attachedRange,
    attachedPath,
    historicalContent,
  };
}
