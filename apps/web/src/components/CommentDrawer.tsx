import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AttachedComment,
  CommentSeverity,
} from "../../../../packages/shared/src/index.js";
import type { Selection } from "./DiffView.js";
export default function CommentDrawer({
  comments,
  path,
  selection,
  creating,
  draftRevision,
  onSave,
  onUpdate,
  onDelete,
  onCancel,
  readOnly = false,
}: {
  comments: AttachedComment[];
  path: string;
  selection: Selection | null;
  creating: boolean;
  draftRevision: number;
  onSave: (body: string, severity: CommentSeverity) => Promise<boolean>;
  onUpdate: (id: string, patch: unknown) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onCancel: () => void;
  readOnly?: boolean;
}) {
  const [body, setBody] = useState(""),
    [severity, setSeverity] = useState<CommentSeverity>("info"),
    [editing, setEditing] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [allNotes, setAllNotes] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null),
    draftGeneration = useRef(0);
  useLayoutEffect(() => {
    draftGeneration.current++;
    setEditing(null);
    setBody("");
    setSeverity("info");
    setBusy(false);
  }, [draftRevision]);
  useEffect(() => {
    if (!creating && !editing) return;
    const previous = document.activeElement as HTMLElement | null;
    textarea.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [creating, editing]);
  const visible = allNotes
    ? comments
    : comments.filter((c) => (c.attachedPath ?? c.path) === path);
  async function save() {
    if (readOnly) return;
    const generation = draftGeneration.current;
    setBusy(true);
    try {
      const saved = editing
        ? await onUpdate(editing, { body, severity })
        : await onSave(body, severity);
      if (saved && generation === draftGeneration.current) {
        setBody("");
        setEditing(null);
      }
    } finally {
      if (generation === draftGeneration.current) setBusy(false);
    }
  }
  return (
    <div className="comments">
      <div className="changes-summary">
        Review notes <small>{comments.length} total</small>
      </div>
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
      {!readOnly && (creating || editing) && (
        <div className="compose">
          <strong>
            {editing
              ? "Edit comment"
              : selection
                ? `${selection.side} lines ${selection.startLine}–${selection.endLine}`
                : "Select a line in the gutter"}
          </strong>
          <label>
            Severity
            <select
              aria-label="Comment severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as CommentSeverity)}
            >
              {["info", "warning", "error"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <textarea
            ref={textarea}
            aria-label="Comment body"
            placeholder="Write a review note…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="compose-actions">
            <button
              onClick={() => {
                setEditing(null);
                onCancel();
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !body.trim() || (!editing && !selection)}
              onClick={() => void save()}
            >
              Save comment
            </button>
          </div>
        </div>
      )}
      {visible.map((c) => (
        <article className="comment" key={c.id}>
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
              <br /> {c.worktreeRoot}
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
            <button
              disabled={readOnly}
              onClick={() => {
                draftGeneration.current++;
                setBusy(false);
                setEditing(c.id);
                setBody(c.body);
                setSeverity(c.severity);
              }}
            >
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
      ))}
      {!creating && visible.length === 0 && (
        <div className="empty">
          No comments yet.
          <br />
          Select a line or range to leave a note.
        </div>
      )}
    </div>
  );
}
