import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Repository } from "../../../../packages/shared/src/index.js";
import type {
  FetchAllResult,
  MergePreview,
  PullPreview,
  RepositorySync,
  SyncMutationResult,
} from "../../../../packages/shared/src/sync.js";
import { api } from "../api.js";
import Modal from "./Modal.js";

function validSync(value: RepositorySync, id: string) {
  return (
    value?.repositoryId === id &&
    Array.isArray(value.remotes) &&
    Array.isArray(value.merge?.conflicts) &&
    Array.isArray(value.merge?.mergeHeads)
  );
}
export function useRepositorySync(repositoryId: string) {
  const [sync, setSync] = useState<RepositorySync | null>(null),
    [error, setError] = useState(""),
    [fetching, setFetching] = useState(false);
  const current = useRef(repositoryId),
    generation = useRef(0),
    fetchingTarget = useRef<{ repositoryId: string } | null>(null),
    statusRequest = useRef<{ repositoryId: string } | null>(null),
    alive = useRef(true);
  current.current = repositoryId;
  async function refresh() {
    const id = current.current,
      request = ++generation.current;
    if (!id) return;
    const operation = { repositoryId: id };
    statusRequest.current = operation;
    try {
      const value = await api<RepositorySync>(
        `/repositories/${encodeURIComponent(id)}/sync`,
      );
      if (
        !alive.current ||
        request !== generation.current ||
        current.current !== id
      )
        return;
      if (!validSync(value, id)) {
        setSync(null);
        return;
      }
      setSync(value);
      setError("");
    } catch (e) {
      if (
        alive.current &&
        request === generation.current &&
        current.current === id
      )
        setError((e as Error).message);
    } finally {
      if (statusRequest.current === operation) statusRequest.current = null;
    }
  }
  async function fetchAll() {
    const id = current.current;
    if (!id || fetchingTarget.current?.repositoryId === id) return;
    const operation = { repositoryId: id };
    fetchingTarget.current = operation;
    setFetching(true);
    setError("");
    const request = ++generation.current;
    try {
      const value = await api<FetchAllResult>(
        `/repositories/${encodeURIComponent(id)}/fetch-all`,
        "POST",
        {},
      );
      if (
        alive.current &&
        current.current === id &&
        request === generation.current
      ) {
        if (!validSync(value.sync, id))
          throw new Error(
            "Fetch response does not match this project. Refresh before retrying.",
          );
        setSync(value.sync);
      }
    } catch (e) {
      if (
        alive.current &&
        current.current === id &&
        request === generation.current
      )
        setError((e as Error).message);
    } finally {
      if (fetchingTarget.current === operation) {
        fetchingTarget.current = null;
        if (alive.current && current.current === id) setFetching(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    statusRequest.current = null;
    fetchingTarget.current = null;
    setSync(null);
    setError("");
    setFetching(false);
    void refresh();
    // The server fetches on its own five-minute cadence. Read only the local
    // status every 30 seconds; unchanged refs and failed fetches need no diff
    // invalidation and must still reach this project's footer.
    const timer = repositoryId
      ? setInterval(() => {
          if (
            current.current === repositoryId &&
            statusRequest.current?.repositoryId !== repositoryId &&
            fetchingTarget.current?.repositoryId !== repositoryId
          )
            void refresh();
        }, 30000)
      : undefined;
    return () => {
      alive.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [repositoryId]);
  return { sync, error, fetching, refresh, fetchAll };
}
export function FetchStatus({
  sync,
  fetching,
  error,
  onFetch,
}: {
  sync: RepositorySync | null;
  fetching: boolean;
  error: string;
  onFetch: () => void;
}) {
  const failures = sync?.remotes.filter((remote) => remote.lastError) ?? [],
    successes =
      sync?.remotes.flatMap((remote) =>
        remote.lastSuccessAt ? [remote.lastSuccessAt] : [],
      ) ?? [];
  const latest = successes.sort().at(-1),
    failed = !!error || failures.length > 0;
  const status =
    fetching || sync?.fetching
      ? "Fetching…"
      : error ||
        (failed
          ? `Fetch failed · ${failures.map((remote) => remote.name).join(", ")}`
          : latest
            ? `Fetched ${new Date(latest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Not fetched yet");
  return (
    <div className="fetch-status">
      <span
        className={`fetch-dot ${failed ? "failed" : latest ? "success" : ""}`}
        aria-hidden="true"
      />
      <span
        role="status"
        title={
          error ||
          failures
            .map((remote) => `${remote.name}: ${remote.lastError}`)
            .join("\n") ||
          latest ||
          "Fetch refreshes all eligible configured remotes"
        }
      >
        {status}
      </span>
      <button
        disabled={
          fetching ||
          !!sync?.fetching ||
          !sync?.available ||
          !sync.remotes.some((remote) => remote.eligible)
        }
        onClick={onFetch}
      >
        Fetch
      </button>
    </div>
  );
}
export default function SyncActions({
  repository,
  comparisonRef,
  sync,
  disabled,
  surface = "toolbar",
  onChanged,
  onDialogChange,
  onResolve,
}: {
  repository: Repository | undefined;
  comparisonRef: string;
  sync: RepositorySync | null;
  disabled: boolean;
  surface?: "toolbar" | "banner";
  onChanged: () => void;
  onDialogChange: (open: boolean) => void;
  onResolve?: () => void;
}) {
  type Plan = PullPreview | MergePreview;
  const [preview, setPreview] = useState<Plan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expired, setExpired] = useState(false);
  const context = `${repository?.id}:${repository?.root}:${comparisonRef}:${sync?.actual?.branch}:${sync?.actual?.head}:${sync?.merge.mergeHeads.join(",")}:${sync?.merge.conflicts.join(",")}:${sync?.merge.canContinue}:${disabled}`;
  const current = useRef(context),
    pending = useRef<object | null>(null),
    mutating = useRef(false);
  current.current = context;
  const prefix = `/repositories/${encodeURIComponent(repository?.id || "")}`;
  const allowed =
    !disabled &&
    !!repository &&
    !!sync?.available &&
    sync.repositoryId === repository?.id &&
    !!sync.writesEnabled &&
    !!sync.actual?.branch?.startsWith("refs/heads/");
  useEffect(() => {
    pending.current = null;
    setBusy(false);
    setPreview(null);
    setError("");
  }, [context]);
  useEffect(
    () => () => {
      current.current = "";
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    onDialogChange(!!preview);
    return () => onDialogChange(false);
  }, [preview, onDialogChange]);
  useEffect(() => {
    if (!preview) {
      setExpired(false);
      return;
    }
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [preview]);
  function matches(plan: Plan) {
    return (
      plan.repositoryId === repository?.id &&
      plan.worktreeRoot === repository.root &&
      plan.localBranch === sync?.actual?.branch &&
      plan.localHead === sync.actual.head &&
      !!plan.previewId &&
      Number.isFinite(Date.parse(plan.expiresAt)) &&
      ("action" in plan
        ? plan.mergeHeads.join("\0") === sync.merge.mergeHeads.join("\0") &&
          plan.conflicts.join("\0") === sync.merge.conflicts.join("\0")
        : plan.comparisonRef === comparisonRef &&
          plan.operation === "merge" &&
          !!plan.comparisonHead &&
          !!plan.remote)
    );
  }
  async function inspect(action?: "continue" | "abort") {
    if (
      !allowed ||
      busy ||
      pending.current ||
      (action === "continue" && !sync?.merge.canContinue)
    )
      return;
    const token = current.current,
      operation = {};
    pending.current = operation;
    setBusy(true);
    setError("");
    try {
      const value = await api<Plan>(
        `${prefix}/${action ? "merge-preview" : "pull-preview"}`,
        "POST",
        action ? { action } : { comparisonRef },
      );
      if (current.current !== token || pending.current !== operation) return;
      if (
        !matches(value) ||
        (action && (!("action" in value) || value.action !== action))
      )
        throw new Error(
          "Merge preview does not match the current project. Refresh before retrying.",
        );
      setPreview(value);
    } catch (e) {
      if (current.current === token && pending.current === operation)
        setError((e as Error).message);
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function close() {
    if (mutating.current) return;
    pending.current = null;
    setBusy(false);
    setPreview(null);
  }
  async function confirm() {
    if (
      !allowed ||
      !preview ||
      busy ||
      pending.current ||
      expired ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      !matches(preview)
    )
      return;
    const plan = preview,
      token = current.current,
      operation = {};
    pending.current = operation;
    mutating.current = true;
    setBusy(true);
    setPreview(null);
    try {
      const result = await api<SyncMutationResult>(
        `${prefix}/${"action" in plan ? "merge" : "pull"}`,
        "POST",
        { previewId: plan.previewId, confirmed: true },
      );
      if (current.current !== token || pending.current !== operation) return;
      if (
        !result.ok ||
        !("action" in plan
          ? result.outcome ===
            (plan.action === "continue" ? "continued" : "aborted")
          : ["merged", "conflicts"].includes(result.outcome)) ||
        !validSync(result.sync, repository!.id)
      )
        throw new Error(
          "Unverifiable merge response. Refresh the actual Git state before retrying.",
        );
      onChanged();
    } catch (e) {
      if (current.current === token && pending.current === operation) {
        setError((e as Error).message);
        onChanged();
      }
    } finally {
      mutating.current = false;
      if (pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <>
      {surface === "toolbar" ? (
        <div className="pull-control">
          <button
            disabled={
              !allowed ||
              busy ||
              !!sync?.merge.pending ||
              !comparisonRef.startsWith("refs/remotes/")
            }
            onClick={() => void inspect()}
          >
            Pull
          </button>
          {error && (
            <span role="alert" className="toolbar-error">
              {error}
            </span>
          )}
        </div>
      ) : (
        sync?.merge.pending && (
          <div className="merge-banner" role="status">
            <span className="merge-icon" aria-hidden="true">
              ⚠
            </span>
            <div>
              <strong>
                Merge paused ·{" "}
                {sync.merge.conflicts.length
                  ? `${sync.merge.conflicts.length} ${sync.merge.conflicts.length === 1 ? "file needs" : "files need"} resolution`
                  : "Resolutions staged"}
              </strong>
              <small>
                {comparisonRef.replace(/^refs\/remotes\//, "")} →{" "}
                {sync.actual?.branch?.replace(/^refs\/heads\//, "")} ·{" "}
                {sync.merge.reason ||
                  "Review staged resolutions before continuing"}
              </small>
              {onResolve && sync.merge.conflicts.length > 0 && (
                <button onClick={onResolve}>Review working conflicts</button>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
            <div className="merge-actions">
              <button
                disabled={!allowed || busy}
                onClick={() => void inspect("abort")}
              >
                Abort merge
              </button>
              <button
                disabled={!allowed || busy || !sync.merge.canContinue}
                onClick={() => void inspect("continue")}
              >
                Continue merge
              </button>
            </div>
          </div>
        )
      )}
      {preview &&
        createPortal(
          <Modal
            label={
              "action" in preview
                ? `Confirm ${preview.action} merge`
                : "Confirm pull"
            }
            onClose={close}
          >
            <h2>
              {"action" in preview
                ? `${preview.action === "continue" ? "Continue" : "Abort"} merge?`
                : "Pull comparison branch?"}
            </h2>
            <p>
              {"action" in preview
                ? preview.action === "abort"
                  ? "Abort the pending merge. Git will restore the pre-merge state where possible. Review the exact worktree before confirming."
                  : "Commit the staged merge resolutions in this exact worktree."
                : "Merge the fetched comparison branch into the actual checked-out local branch. Conflicts pause the merge for manual resolution."}
            </p>
            <dl className="exact-target">
              <dt>Worktree</dt>
              <dd>{preview.worktreeRoot}</dd>
              <dt>Local branch</dt>
              <dd>{preview.localBranch}</dd>
              <dt>Current HEAD</dt>
              <dd>{preview.localHead}</dd>
              {"action" in preview ? (
                <>
                  <dt>Merge heads</dt>
                  <dd>{preview.mergeHeads.join("\n")}</dd>
                  <dt>Unmerged paths</dt>
                  <dd>
                    {preview.conflicts.length
                      ? preview.conflicts.join("\n")
                      : "None"}
                  </dd>
                </>
              ) : (
                <>
                  <dt>Comparison branch</dt>
                  <dd>{preview.comparisonRef}</dd>
                  <dt>Exact comparison commit</dt>
                  <dd>{preview.comparisonHead}</dd>
                  <dt>Remote</dt>
                  <dd>{preview.remote}</dd>
                </>
              )}
            </dl>
            {expired && (
              <p role="alert">Preview expired. Refresh and inspect again.</p>
            )}
            <div className="compose-actions">
              <button onClick={close}>Cancel</button>
              <button
                className={
                  "action" in preview && preview.action === "abort"
                    ? "danger"
                    : "primary"
                }
                disabled={busy || expired || !allowed}
                onClick={() => void confirm()}
              >
                {"action" in preview
                  ? `Confirm ${preview.action}`
                  : "Confirm pull"}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
