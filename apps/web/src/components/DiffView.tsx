import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EditorView, Decoration } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import type {
  FileDiff,
  AttachedComment,
  CommentSide,
  DiffLine,
} from "../../../../packages/shared/src/index.js";
export interface Selection {
  side: CommentSide;
  startLine: number;
  endLine: number;
  anchor: number;
}
const darkHighlight = HighlightStyle.define(
  [
    { tag: tags.keyword, color: "#c792ea" },
    { tag: [tags.variableName, tags.propertyName], color: "#a9c7ff" },
    { tag: [tags.string, tags.special(tags.string)], color: "#c3dc96" },
    { tag: tags.number, color: "#f5bb81" },
    { tag: tags.comment, color: "#8793a7" },
    { tag: tags.typeName, color: "#75d4c8" },
  ],
  { themeType: "dark" },
);
function Code({
  lines,
  path,
  dark,
  side,
  start,
  end,
}: {
  lines: DiffLine[];
  path: string;
  dark: boolean;
  side?: CommentSide;
  start: number;
  end: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const language = /\.(tsx?|jsx?)$/.test(path)
      ? javascript({
          typescript: /\.tsx?$/.test(path),
          jsx: /\.[jt]sx$/.test(path),
        })
      : path.endsWith(".py")
        ? python()
        : path.endsWith(".json")
          ? json()
          : path.endsWith(".css")
            ? css()
            : path.endsWith(".html")
              ? html()
              : [];
    const paneLines = lines.map((line) =>
      (side === "old" && line.type === "add") ||
      (side === "new" && line.type === "delete")
        ? { ...line, text: "", type: "context" as const }
        // Git preserves CRLF in raw source/anchor text. Normalize only this
        // display model so CodeMirror and excerpt offsets use identical bytes.
        : { ...line, text: line.text.replace(/\r$/, "") },
    );
    const doc = paneLines.map((line) => line.text).join("\n");
    const offsets: number[] = [];
    let position = 0;
    for (const line of paneLines) {
      offsets.push(position);
      position += line.text.length + 1;
    }
    const decorations = paneLines.map((line, index) =>
      Decoration.line({ class: `code-${line.type}` }).range(offsets[index]),
    );
    // Keep the complete hunk in the parser. Only its visible excerpt is hidden
    // with block replacements, so a comment/string spanning an inline row keeps
    // exactly the syntax context it had before that row was inserted.
    // The excerpt-facing edges stay exclusive so a zero-width blank split
    // placeholder at either boundary still produces its own visible line.
    if (start > 0) {
      decorations.push(
        Decoration.replace({ block: true, inclusiveEnd: false }).range(
          0,
          offsets[start],
        ),
      );
    }
    if (end < paneLines.length) {
      const visibleEnd = offsets[end - 1] + paneLines[end - 1].text.length;
      decorations.push(
        Decoration.replace({ block: true, inclusiveStart: false }).range(
          visibleEnd,
          doc.length,
        ),
      );
    }
    const state = EditorState.create({
      doc,
      extensions: [
        language,
        syntaxHighlighting(dark ? darkHighlight : defaultHighlightStyle),
        EditorView.darkTheme.of(dark),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.decorations.of(Decoration.set(decorations, true)),
        EditorView.theme({
          "&": { fontSize: "15px" },
          ".cm-content": {
            padding: "0",
            fontFamily: "SFMono-Regular,Consolas,monospace",
          },
          ".cm-line": { padding: "0 12px", height: "24px", lineHeight: "24px" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current! });
    return () => view.destroy();
  }, [lines, path, dark, side, start, end]);
  return <div className="code" ref={host} />;
}
function InlineThread({
  comment,
  renderComment,
}: {
  comment: AttachedComment;
  renderComment?: (comment: AttachedComment) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const controls = useId();
  const range = comment.attachedRange!;
  return (
    <div className="inline-comment-thread" data-comment-id={comment.id}>
      <button
        className="inline-comment-marker"
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={() => setExpanded((value) => !value)}
      >
        {comment.side} lines {range.startLine}–{range.endLine} · 1 note ·{" "}
        {comment.status}
      </button>
      <div id={controls} className="inline-comment-expanded" hidden={!expanded}>
        {expanded &&
          (renderComment ? renderComment(comment) : <p>{comment.body}</p>)}
      </div>
    </div>
  );
}

export default function DiffView({
  diff,
  split,
  dark,
  selection,
  onSelect,
  disabled = false,
  hunkAction,
  inlineSelection,
  inlineContent,
  onInlineComment,
  comments = [],
  renderComment,
}: {
  diff: FileDiff;
  split: boolean;
  dark: boolean;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  disabled?: boolean;
  hunkAction?: {
    label: "Stage" | "Unstage";
    disabled: boolean;
    run: (index: number) => void;
  };
  inlineSelection?: Selection | null;
  inlineContent?: React.ReactNode;
  onInlineComment?: () => void;
  comments?: AttachedComment[];
  renderComment?: (comment: AttachedComment) => React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const focusedGutter = useRef<string | null>(null);
  const target = inlineSelection === undefined ? selection : inlineSelection;
  const hasInlineContent =
    inlineContent !== undefined && inlineContent !== null;
  const visibleComments = comments.filter(
    (comment) =>
      comment.attachment === "current" &&
      comment.attachedRange !== null &&
      (comment.attachedPath ?? comment.path) === diff.path,
  );
  // Changing endpoint partitions can replace a gutter DOM node. Restore only
  // that same gutter if it actually lost focus, never move focus to a composer.
  useLayoutEffect(() => {
    if (!focusedGutter.current || document.activeElement !== document.body)
      return;
    const button = Array.from(
      host.current?.querySelectorAll<HTMLButtonElement>(".gutter-row button") ??
        [],
    ).find(
      (button) => button.getAttribute("aria-label") === focusedGutter.current,
    );
    button?.focus({ preventScroll: true });
  });

  function select(side: CommentSide, line: number, shift: boolean) {
    if (disabled) return;
    const anchor = shift && selection?.side === side ? selection.anchor : line;
    onSelect({
      side,
      startLine: Math.min(anchor, line),
      endLine: Math.max(anchor, line),
      anchor,
    });
  }
  function pane(
    lines: DiffLine[],
    start: number,
    end: number,
    side?: CommentSide,
  ) {
    return (
      <div className="diff-pane" data-side={side}>
        <div className="gutters">
          {lines.slice(start, end).map((original, i) => {
            const line =
              (side === "old" && original.type === "add") ||
              (side === "new" && original.type === "delete")
                ? { ...original, type: "context" as const }
                : original;
            return (
              <div className={`gutter-row ${line.type}`} key={start + i}>
                {(["old", "new"] as const)
                  .filter((s) => !side || s === side)
                  .map((s) => {
                    const number = s === "old" ? line.oldLine : line.newLine;
                    return number === null ? (
                      <span key={s} />
                    ) : (
                      <button
                        key={s}
                        disabled={disabled}
                        aria-label={`${s} line ${number}`}
                        className={
                          selection?.side === s &&
                          number >= selection.startLine &&
                          number <= selection.endLine
                            ? "selected"
                            : ""
                        }
                        onFocus={() => {
                          focusedGutter.current = `${s} line ${number}`;
                        }}
                        onBlur={(event) => {
                          // A real blur clears the target even when focus goes to
                          // the page background. Removal during partitioning
                          // either emits no blur or blurs a disconnected node.
                          if (event.currentTarget.isConnected)
                            focusedGutter.current = null;
                        }}
                        onClick={(event) => select(s, number, event.shiftKey)}
                      >
                        {number}
                      </button>
                    );
                  })}
                <span className="sign">
                  {line.type === "add"
                    ? "+"
                    : line.type === "delete"
                      ? "−"
                      : " "}
                </span>
              </div>
            );
          })}
        </div>
        <Code
          lines={lines}
          path={diff.path}
          dark={dark}
          side={side}
          start={start}
          end={end}
        />
      </div>
    );
  }
  function hunkBody(lines: DiffLine[]) {
    const endpoints = new Map<
      number,
      { old: AttachedComment[]; new: AttachedComment[]; target?: Selection }
    >();
    function endpoint(side: CommentSide, line: number) {
      const index = lines.findIndex(
        (entry) => (side === "old" ? entry.oldLine : entry.newLine) === line,
      );
      if (index < 0) return null;
      let value = endpoints.get(index);
      if (!value) {
        value = { old: [], new: [] };
        endpoints.set(index, value);
      }
      return value;
    }
    for (const comment of visibleComments) {
      endpoint(comment.side, comment.attachedRange!.endLine)?.[
        comment.side
      ].push(comment);
    }
    if (target && (hasInlineContent || onInlineComment)) {
      const value = endpoint(target.side, target.endLine);
      if (value) value.target = target;
    }
    const rows: React.ReactNode[] = [];
    let start = 0;
    function segment(end: number) {
      if (start >= end) return;
      rows.push(
        <div
          className={`diff-segment${split ? " split-row" : ""}`}
          key={`lines-${start}`}
        >
          {split ? (
            <>
              {pane(lines, start, end, "old")}
              {pane(lines, start, end, "new")}
            </>
          ) : (
            pane(lines, start, end)
          )}
        </div>,
      );
      start = end;
    }
    for (const [index, value] of [...endpoints].sort(([a], [b]) => a - b)) {
      segment(index + 1);
      function slot(side: CommentSide) {
        const anchored = value.target?.side === side ? value.target : null;
        const number =
          side === "old" ? lines[index].oldLine : lines[index].newLine;
        return (
          <div
            key={side}
            className="inline-diff-slot"
            data-side={side}
            data-inline-end-line={number ?? undefined}
          >
            {anchored &&
              (hasInlineContent
                ? inlineContent
                : onInlineComment && (
                    <button
                      className="inline-comment-trigger"
                      disabled={disabled}
                      onClick={onInlineComment}
                    >
                      Comment inline
                    </button>
                  ))}
            {value[side].map((comment) => (
              <InlineThread
                key={comment.id}
                comment={comment}
                renderComment={renderComment}
              />
            ))}
          </div>
        );
      }
      rows.push(
        <div
          className={`inline-diff-row${split ? " split-row" : ""}`}
          key={`inline-${index}`}
        >
          {split ? (
            <>
              {slot("old")}
              {slot("new")}
            </>
          ) : (
            (["old", "new"] as const)
              .filter(
                (side) => value[side].length || value.target?.side === side,
              )
              .map(slot)
          )}
        </div>,
      );
    }
    segment(lines.length);
    return rows;
  }
  return (
    <div
      ref={host}
      data-testid="diff"
      className={split ? "diff split" : "diff unified"}
    >
      {diff.unsupportedReason ? (
        <div className="empty">{diff.unsupportedReason}</div>
      ) : diff.hunks.length === 0 ? (
        <div className="empty">No textual changes in this file.</div>
      ) : (
        diff.hunks.map((h, i) => (
          <section className="hunk" id={`hunk-${i}`} key={i}>
            <div className="hunk-heading">
              <span>
                @@ −{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@
              </span>
              {hunkAction && (
                <button
                  disabled={hunkAction.disabled}
                  aria-label={`${hunkAction.label} hunk ${i + 1}`}
                  onClick={() => hunkAction.run(i)}
                >
                  {hunkAction.label} hunk
                </button>
              )}
            </div>
            {hunkBody(h.lines)}
          </section>
        ))
      )}
    </div>
  );
}
