import React, { useEffect, useRef } from "react";
import type { CommentSeverity } from "../../../../packages/shared/src/index.js";
import type { CommentDraft } from "../commentDraft.js";
import type { Selection } from "./DiffView.js";
export default function CommentComposer({
  draft,
  selection,
  selectedRange,
  stale,
  pending,
  onRetarget,
  onCancel,
  onSurface,
  surface,
}: {
  draft: CommentDraft;
  selection: Selection | null;
  selectedRange: Selection | null;
  stale: boolean;
  pending: boolean;
  onRetarget: () => void;
  onCancel: () => void;
  onSurface?: () => void;
  surface: "sidebar" | "inline";
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    textarea.current?.focus({ preventScroll: true });
    textarea.current?.scrollIntoView?.({ block: "nearest" });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [draft.editing]);
  const different =
    !draft.editing &&
    selection &&
    selectedRange &&
    (selection.side !== selectedRange.side ||
      selection.startLine !== selectedRange.startLine ||
      selection.endLine !== selectedRange.endLine);
  return (
    <div className="compose" aria-label={`${surface} comment composer`}>
      <strong>
        {draft.editing
          ? "Edit comment"
          : selection
            ? `${selection.side} lines ${selection.startLine}–${selection.endLine}`
            : "Select a line in the gutter"}
      </strong>
      {stale && !draft.editing && (
        <p role="status">Range changed; select current lines before saving.</p>
      )}
      {different && (
        <div className="draft-target" role="status">
          Draft remains on {selection.side} lines {selection.startLine}–
          {selection.endLine}.
          <button onClick={onRetarget}>Use selected lines</button>
        </div>
      )}
      <label>
        Severity
        <select
          aria-label="Comment severity"
          value={draft.severity}
          onChange={(e) =>
            draft.changeSeverity(e.target.value as CommentSeverity)
          }
        >
          {["info", "warning", "error"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <textarea
        ref={textarea}
        aria-label="Comment body"
        placeholder="Write a review note…"
        value={draft.body}
        onChange={(e) => draft.changeBody(e.target.value)}
      />
      <div className="compose-actions">
        {onSurface && (
          <button onClick={onSurface}>
            {surface === "inline" ? "Comment in sidebar" : "Continue inline"}
          </button>
        )}
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={
            draft.busy ||
            pending ||
            !draft.body.trim() ||
            (!draft.editing && (!selection || stale))
          }
          onClick={() => void draft.save()}
        >
          Save comment
        </button>
      </div>
    </div>
  );
}
