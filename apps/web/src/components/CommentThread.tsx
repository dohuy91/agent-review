import React from "react";
import type { AttachedComment } from "../../../../packages/shared/src/index.js";
export default function CommentThread({
  comment: c,
  allNotes = false,
  readOnly = false,
  onEdit,
  onUpdate,
  onDelete,
}: {
  comment: AttachedComment;
  allNotes?: boolean;
  readOnly?: boolean;
  onEdit: (comment: AttachedComment) => void;
  onUpdate: (id: string, patch: unknown) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <article className="comment" data-comment-id={c.id}>
      <strong className="note-file">
        {c.path}
        {c.attachedPath && c.attachedPath !== c.path
          ? ` → ${c.attachedPath}`
          : ""}
      </strong>
      {allNotes && (
        <div className="note-context">
          Original: {c.side} {c.startLine}–{c.endLine} · {c.mode} ·{" "}
          {c.branch || "detached"} · base {c.base?.slice(0, 8)} →{" "}
          {c.head?.slice(0, 8)}
          <br />
          {c.worktreeRoot}
        </div>
      )}
      <div className="comment-meta">
        <span className={`severity ${c.severity}`}>{c.severity}</span>
        <span>
          {c.side} {c.attachedRange?.startLine ?? c.startLine}–
          {c.attachedRange?.endLine ?? c.endLine}
        </span>
        <span>{c.status}</span>
      </div>
      <p>{c.body}</p>
      {c.attachment === "outdated" && (
        <div className="outdated">
          Outdated · historical content {c.historicalContent}
        </div>
      )}
      <div className="comment-actions">
        <button disabled={readOnly} onClick={() => onEdit(c)}>
          Edit
        </button>
        <button
          disabled={readOnly}
          onClick={() =>
            void onUpdate(c.id, {
              status: c.status === "open" ? "resolved" : "open",
            })
          }
        >
          {c.status === "open" ? "Resolve" : "Reopen"}
        </button>
        <button disabled={readOnly} onClick={() => void onDelete(c.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}
