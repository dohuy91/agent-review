import { useLayoutEffect, useRef, useState } from "react";
import type {
  AttachedComment,
  CommentSeverity,
} from "../../../packages/shared/src/index.js";

/** One editor model survives drawer/tab/view/surface changes. */
export function useCommentDraft({
  revision,
  scope = "default",
  onSave,
  onUpdate,
  onComplete,
}: {
  revision: number;
  scope?: string;
  onSave: (body: string, severity: CommentSeverity) => Promise<boolean>;
  onUpdate: (id: string, patch: unknown) => Promise<boolean>;
  onComplete: () => void;
}) {
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<CommentSeverity>("info");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0),
    action = useRef(0),
    alive = useRef(true);
  function clear() {
    version.current++;
    action.current++;
    setBody("");
    setSeverity("info");
    setEditing(null);
    setBusy(false);
  }
  const drafts = useRef(
    new Map<
      string,
      { body: string; severity: CommentSeverity; editing: string | null }
    >(),
  );
  const previousScope = useRef(scope);
  const snapshot = useRef({ body, severity, editing });
  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      drafts.current.set(previousScope.current, snapshot.current);
      const saved = drafts.current.get(scope);
      version.current++;
      action.current++;
      setBody(saved?.body ?? "");
      setSeverity(saved?.severity ?? "info");
      setEditing(saved?.editing ?? null);
      setBusy(false);
      previousScope.current = scope;
    }
  }, [scope]);
  useLayoutEffect(() => {
    snapshot.current = { body, severity, editing };
  });
  useLayoutEffect(clear, [revision]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      action.current++;
      version.current++;
    };
  }, []);
  function edit(comment: AttachedComment) {
    version.current++;
    action.current++;
    setBody(comment.body);
    setSeverity(comment.severity);
    setEditing(comment.id);
    setBusy(false);
  }
  async function save() {
    if (busy || !body.trim()) return;
    const savedVersion = version.current,
      request = ++action.current;
    setBusy(true);
    try {
      const saved = editing
        ? await onUpdate(editing, { body, severity })
        : await onSave(body, severity);
      if (
        saved &&
        alive.current &&
        savedVersion === version.current &&
        request === action.current
      ) {
        clear();
        onComplete();
      }
    } finally {
      if (alive.current && request === action.current) setBusy(false);
    }
  }
  return {
    body,
    severity,
    editing,
    busy,
    edit,
    clear,
    save,
    changeBody(value: string) {
      version.current++;
      setBody(value);
    },
    changeSeverity(value: CommentSeverity) {
      version.current++;
      setSeverity(value);
    },
  };
}
export type CommentDraft = ReturnType<typeof useCommentDraft>;
