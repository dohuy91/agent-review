import React, { useEffect, useRef } from "react";
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
}: {
  lines: DiffLine[];
  path: string;
  dark: boolean;
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
    const state = EditorState.create({
      doc: lines.map((l) => l.text).join("\n"),
      extensions: [
        language,
        syntaxHighlighting(dark ? darkHighlight : defaultHighlightStyle),
        EditorView.darkTheme.of(dark),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.decorations.of(
          Decoration.set(
            lines.map((line, index) =>
              Decoration.line({ class: `code-${line.type}` }).range(
                lines
                  .slice(0, index)
                  .reduce((n, l) => n + l.text.length + 1, 0),
              ),
            ),
          ),
        ),
        EditorView.theme({
          "&": { fontSize: "12px" },
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
  }, [lines, path, dark]);
  return <div className="code" ref={host} />;
}
export default function DiffView({
  diff,
  split,
  dark,
  selection,
  onSelect,
  disabled = false,
}: {
  diff: FileDiff;
  split: boolean;
  dark: boolean;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  disabled?: boolean;
}) {
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
  function pane(lines: DiffLine[], side?: CommentSide) {
    return (
      <div className="diff-pane">
        <div className="gutters">
          {lines.map((line, i) => (
            <div className={`gutter-row ${line.type}`} key={i}>
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
                      onClick={(e) => select(s, number, e.shiftKey)}
                    >
                      {number}
                    </button>
                  );
                })}
              <span className="sign">
                {line.type === "add" ? "+" : line.type === "delete" ? "−" : " "}
              </span>
            </div>
          ))}
        </div>
        <Code lines={lines} path={diff.path} dark={dark} />
      </div>
    );
  }
  return (
    <div data-testid="diff" className={split ? "diff split" : "diff unified"}>
      {diff.unsupportedReason ? (
        <div className="empty">{diff.unsupportedReason}</div>
      ) : diff.hunks.length === 0 ? (
        <div className="empty">No textual changes in this file.</div>
      ) : (
        diff.hunks.map((h, i) => (
          <section className="hunk" id={`hunk-${i}`} key={i}>
            <div className="hunk-heading">
              @@ −{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@
            </div>
            {split ? (
              <div className="split-row">
                {pane(
                  h.lines.map((l) =>
                    l.type === "add"
                      ? { ...l, text: "", type: "context" as const }
                      : l,
                  ),
                  "old",
                )}
                {pane(
                  h.lines.map((l) =>
                    l.type === "delete"
                      ? { ...l, text: "", type: "context" as const }
                      : l,
                  ),
                  "new",
                )}
              </div>
            ) : (
              pane(h.lines)
            )}
          </section>
        ))
      )}
    </div>
  );
}
