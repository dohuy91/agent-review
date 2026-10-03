import React, { useState } from "react";
import type { AttachedComment } from "../../../../packages/shared/src/index.js";
import CommentThread from "./CommentThread.js";
export default function CommentDrawer({
  comments,
  path,
  onEdit,
  onUpdate,
  onDelete,
  readOnly = false,
}: {
  comments: AttachedComment[];
  path: string;
  onEdit: (comment: AttachedComment) => void;
  onUpdate: (id: string, patch: unknown) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  readOnly?: boolean;
}) {
  const [allNotes, setAllNotes] = useState(false);
  const visible = allNotes
    ? comments
    : comments.filter((c) => (c.attachedPath ?? c.path) === path);
  return (
    <div className="comments">
      <div className="notes-filter">
        <button
          className={!allNotes ? "active" : ""}
          onClick={() => setAllNotes(false)}
        >
          This file
        </button>
        <button
          className={allNotes ? "active" : ""}
          onClick={() => setAllNotes(true)}
        >
          All notes
        </button>
      </div>
      {visible.map((c) => (
        <CommentThread
          key={c.id}
          comment={c}
          allNotes={allNotes}
          readOnly={readOnly}
          onEdit={onEdit}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
      {visible.length === 0 && (
        <div className="empty">
          No comments yet.
          <br />
          Select a line or range to leave a note.
        </div>
      )}
    </div>
  );
}
