import type {
  Repository,
  ReviewObservation,
  ReviewComment,
  AttachedComment,
  FileDiff,
} from "../../shared/src/index.js";
import { attach, makeAnchor } from "./anchors.js";
import { getFileDiff } from "../../git/src/diff.js";
import { git } from "../../git/src/git.js";
const MAX_ATTACHMENT_WORK = 4;
interface AttachmentWork {
  diff(path: string): Promise<FileDiff>;
  historical(oid: string): Promise<AttachedComment["historicalContent"]>;
}
// All caches belong to one observation validation pass. In-flight promises are
// stored before work starts, and the scheduler bounds both diff and object work.
export function createAttachmentResolver(
  repository: Repository,
  observation: ReviewObservation,
) {
  const diffs = new Map<string, Promise<FileDiff>>();
  const objects = new Map<
    string,
    Promise<AttachedComment["historicalContent"]>
  >();
  let active = 0;
  const queued: (() => void)[] = [];
  function pump() {
    while (active < MAX_ATTACHMENT_WORK && queued.length) queued.shift()!();
  }
  function bounded<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queued.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  }
  const work: AttachmentWork = {
    diff(path) {
      if (!diffs.has(path))
        diffs.set(
          path,
          bounded(() => getFileDiff(repository, observation, path)),
        );
      return diffs.get(path)!;
    },
    historical(oid) {
      if (!objects.has(oid))
        objects.set(
          oid,
          bounded(async () => {
            try {
              await git(repository.root, ["cat-file", "-e", `${oid}^{blob}`]);
              return "available" as const;
            } catch {
              return "unavailable" as const;
            }
          }),
        );
      return objects.get(oid)!;
    },
  };
  const resolve = (comment: ReviewComment) =>
    attachWithWork(repository, observation, comment, work);
  return {
    attach: resolve,
    async attachAll(comments: ReviewComment[]) {
      const result: AttachedComment[] = new Array(comments.length);
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(MAX_ATTACHMENT_WORK, comments.length) },
          async () => {
            while (next < comments.length) {
              const index = next++;
              result[index] = await resolve(comments[index]!);
            }
          },
        ),
      );
      return result;
    },
  };
}
export async function attachComment(
  repository: Repository,
  observation: ReviewObservation,
  comment: ReviewComment,
): Promise<AttachedComment> {
  return createAttachmentResolver(repository, observation).attach(comment);
}
async function attachWithWork(
  repository: Repository,
  observation: ReviewObservation,
  comment: ReviewComment,
  work: AttachmentWork,
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
    const diff = await work.diff(file.path);
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
    historicalContent = await work.historical(comment.sourceOid);
  }
  return {
    ...comment,
    attachment: attachedRange ? "current" : "outdated",
    attachedRange,
    attachedPath,
    historicalContent,
  };
}
