import React, { useEffect, useRef, useState } from "react";
import type {
  BranchSwitchFailure,
  BranchSwitchPreview,
  BranchSwitchRequest,
  BranchSwitchResult,
} from "../../../../packages/shared/src/branch-switch.js";
import Modal from "./Modal.js";
import "./BranchSwitchDialog.css";

class SwitchError extends Error {
  constructor(public detail: BranchSwitchFailure) {
    super(detail.error);
  }
}
async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new SwitchError(result);
  return result as T;
}
export default function BranchSwitchDialog({
  repositoryId,
  reviewId,
  targetRef,
  onCancel,
  onComplete,
  onSaved,
  onOpenRepository,
  onBusyChange,
}: {
  repositoryId: string;
  reviewId: string;
  targetRef: string;
  onCancel: () => void;
  onComplete: (result: BranchSwitchResult) => void;
  onSaved: (failure: BranchSwitchFailure) => Promise<string | null>;
  onOpenRepository: (id: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState<BranchSwitchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<BranchSwitchFailure | null>(null);
  const [strategy, setStrategy] = useState<"stash" | "commit">("stash");
  const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const alive = useRef(true),
    generation = useRef(0),
    currentReview = useRef(reviewId),
    operationBusy = useRef(false);
  const prefix = `/repositories/${encodeURIComponent(repositoryId)}`;
  function setOperationBusy(value: boolean) {
    operationBusy.current = value;
    setBusy(value);
    onBusyChange?.(value);
  }
  function cancel() {
    if (operationBusy.current) return;
    alive.current = false;
    onCancel();
  }
  async function loadPreview(id = currentReview.current, automatic = true) {
    const requestGeneration = generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await request<BranchSwitchPreview>(
        `${prefix}/branch-switch-preview`,
        { reviewId: id, targetRef },
      );
      if (!alive.current || requestGeneration !== generation.current) return;
      currentReview.current = id;
      setPreview(result);
      setPaths(result.dirty.staged);
      setStrategy("stash");
      if (
        automatic &&
        (result.status === "clean" || result.status === "same-branch")
      )
        await execute(
          { previewId: result.previewId, strategy: "clean" },
          requestGeneration,
        );
    } catch (failure) {
      if (alive.current && requestGeneration === generation.current)
        setError((failure as Error).message);
    } finally {
      if (alive.current && requestGeneration === generation.current)
        setLoading(false);
    }
  }
  async function execute(
    payload: BranchSwitchRequest,
    requestGeneration = generation.current,
  ) {
    if (
      operationBusy.current ||
      !alive.current ||
      requestGeneration !== generation.current
    )
      return;
    setOperationBusy(true);
    setError("");
    try {
      const result = await request<BranchSwitchResult>(
        `${prefix}/branch-switch`,
        payload,
      );
      if (alive.current && requestGeneration === generation.current)
        onComplete(result);
    } catch (failure) {
      if (!alive.current || requestGeneration !== generation.current) return;
      setError((failure as Error).message);
      const detail = failure instanceof SwitchError ? failure.detail : null;
      if (detail) setPreview(null);
      if (detail?.commit || detail?.stash || detail?.outcome === "uncertain") {
        setRecovery(detail);
        setPreview(null);
        const refreshed = await onSaved(detail);
        if (!alive.current || requestGeneration !== generation.current) return;
        if (
          refreshed &&
          detail.reason === "remaining-dirty" &&
          detail.outcome === "saved-not-switched"
        ) {
          currentReview.current = refreshed;
          await loadPreview(refreshed, false);
          setError(
            "The selected staged files were committed. Local changes remain, so the branch has not switched. Choose Stash & switch or Cancel.",
          );
        } else if (refreshed) currentReview.current = refreshed;
      }
    } finally {
      if (alive.current && requestGeneration === generation.current)
        setOperationBusy(false);
    }
  }
  useEffect(() => {
    generation.current++;
    alive.current = true;
    currentReview.current = reviewId;
    operationBusy.current = false;
    setBusy(false);
    setPreview(null);
    setRecovery(null);
    setMessage("");
    void loadPreview();
    return () => {
      alive.current = false;
      generation.current++;
      onBusyChange?.(false);
    };
  }, [repositoryId, targetRef]);
  return (
    <Modal label="Switch local branch" onClose={cancel}>
      <div className="branch-switch-dialog">
        <h2>Switch local branch</h2>
        <p className="branch-switch-ref">
          {preview?.from.branch || "Current branch"} → {targetRef}
        </p>
        {(loading || busy) && (
          <p role="status">
            {busy
              ? "Switching branches…"
              : "Checking the branch and local changes…"}
          </p>
        )}
        {preview?.status === "dirty" && (
          <>
            <p>Local changes need to be saved before switching.</p>
            <div className="branch-switch-dirty">
              {(["staged", "unstaged", "untracked"] as const).map((kind) => (
                <div key={kind}>
                  <strong>
                    {kind === "staged"
                      ? "Staged"
                      : kind === "unstaged"
                        ? "Unstaged"
                        : "Untracked"}
                  </strong>
                  {preview.dirty[kind].length ? (
                    <ul>
                      {preview.dirty[kind].map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  ) : (
                    <small>None</small>
                  )}
                </div>
              ))}
            </div>
            <fieldset disabled={busy || loading}>
              <legend>Save local work</legend>
              <label>
                <input
                  type="radio"
                  name="switch-strategy"
                  checked={strategy === "stash"}
                  onChange={() => setStrategy("stash")}
                />
                Stash changes
              </label>
              <label>
                <input
                  type="radio"
                  name="switch-strategy"
                  checked={strategy === "commit"}
                  onChange={() => setStrategy("commit")}
                />
                Commit staged files
              </label>
            </fieldset>
            {strategy === "stash" ? (
              <p>
                Staged, unstaged and untracked work will be saved in a retained
                stash on the current branch.
              </p>
            ) : (
              <div className="branch-switch-commit">
                <p>
                  Select the staged files and enter a commit message. Any
                  remaining local changes will need a separate decision.
                </p>
                {preview.dirty.staged.map((path) => (
                  <label key={path}>
                    <input
                      type="checkbox"
                      checked={paths.includes(path)}
                      disabled={busy}
                      onChange={(event) =>
                        setPaths((selected) =>
                          event.target.checked
                            ? [...selected, path]
                            : selected.filter((item) => item !== path),
                        )
                      }
                    />
                    {path}
                  </label>
                ))}
                {!preview.dirty.staged.length && (
                  <small>No staged files are available to commit.</small>
                )}
                <label>
                  Commit message
                  <textarea
                    aria-label="Branch switch commit message"
                    value={message}
                    disabled={busy}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                </label>
              </div>
            )}
            <button
              className="primary"
              disabled={
                busy ||
                loading ||
                (strategy === "commit" && (!paths.length || !message.trim()))
              }
              onClick={() =>
                void execute({
                  previewId: preview.previewId,
                  strategy,
                  confirmed: true,
                  ...(strategy === "commit"
                    ? { commit: { paths, message } }
                    : {}),
                })
              }
            >
              {strategy === "stash" ? "Stash & switch" : "Commit & switch"}
            </button>
          </>
        )}
        {preview?.status === "occupied" && (
          <>
            <p>This branch is checked out in another worktree.</p>
            <p className="branch-switch-ref">{preview.occupied?.root}</p>
            {preview.occupied?.repositoryId && (
              <button
                onClick={() => {
                  cancel();
                  onOpenRepository(preview.occupied!.repositoryId!);
                }}
              >
                Open registered worktree
              </button>
            )}
          </>
        )}
        {preview &&
          (preview.status === "clean" || preview.status === "same-branch") &&
          !loading &&
          !busy && (
            <button
              className="primary"
              onClick={() =>
                void execute({
                  previewId: preview.previewId,
                  strategy: "clean",
                })
              }
            >
              Switch branch
            </button>
          )}
        {recovery?.stash && (
          <p className="branch-switch-recovery">
            Retained stash: {recovery.stash.oid} · {recovery.stash.sourceBranch}
          </p>
        )}
        {recovery?.commit && (
          <p className="branch-switch-recovery">
            Saved commit: {recovery.commit}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {error && !preview && !busy && (
          <button
            onClick={async () => {
              const requestGeneration = generation.current;
              const refreshed = await onSaved(
                recovery || { error, outcome: "not-switched", reason: "stale" },
              );
              if (
                refreshed &&
                alive.current &&
                requestGeneration === generation.current
              )
                await loadPreview(refreshed, false);
            }}
          >
            Refresh branch status
          </button>
        )}
        <button disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
