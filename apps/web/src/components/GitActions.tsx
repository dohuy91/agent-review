import { createPortal } from "react-dom";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  Repository,
  ReviewObservation,
  GitCapabilities,
  GitRemotesResponse,
  DiscardPreview,
  GitActionResult,
  GitCommitResult,
} from "../../../../packages/shared/src/index.js";
import { api } from "../api.js";
import Modal from "./Modal.js";
import PushActions, { type PushActionsHandle } from "./PushActions.js";
import type {
  ComparisonPushDestination,
  ComparisonPushDestinationsResponse,
} from "../../../../packages/shared/src/push.js";
export interface GitActionsHandle {
  stage: (hunkIndex?: number) => void;
  unstage: (hunkIndex?: number) => void;
  discard: () => void;
  commit: () => void;
  fetch: () => void;
  close: () => void;
}
export default forwardRef<
  GitActionsHandle,
  {
    repository: Repository | undefined;
    review: ReviewObservation | null;
    path: string;
    diffReady: boolean;
    reviewReady: boolean;
    onRefresh: () => void;
    onDialogChange: (open: boolean) => void;
    onWritableChange: (enabled: boolean) => void;
  }
>(function GitActions(
  {
    repository,
    review,
    path,
    diffReady,
    reviewReady,
    onRefresh,
    onDialogChange,
    onWritableChange,
  },
  ref,
) {
  const [capabilities, setCapabilities] = useState<GitCapabilities | null>(
      null,
    ),
    [remotes, setRemotes] = useState<GitRemotesResponse["remotes"]>([]),
    [comparisonDestinations, setComparisonDestinations] = useState<
      ComparisonPushDestination[]
    >([]),
    [remote, setRemote] = useState(""),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<DiscardPreview | null>(null),
    [pushDialog, setPushDialog] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [message, setMessage] = useState("");
  const context = `${repository?.id ?? ""}:${review?.id ?? ""}:${review?.fingerprint ?? ""}:${!!review?.historical}`;
  const current = useRef(context),
    currentPath = useRef(path),
    pending = useRef<object | null>(null),
    messageRevision = useRef(0);
  const pushActions = useRef<PushActionsHandle>(null);
  current.current = context;
  currentPath.current = path;
  const prefix = `/repositories/${encodeURIComponent(repository?.id ?? "")}`;
  const writable =
    reviewReady &&
    !!repository &&
    !!review &&
    !review.historical &&
    review.executionEligible !== false &&
    !!capabilities?.writesEnabled;
  const file = review?.files.find((file) => file.path === path);
  const fileEnabled =
    writable && !!file && file.kind === "text" && diffReady && !busy;
  const staged = review?.mode === "staged";
  const eligible = staged
    ? (review?.files.filter((file) => file.kind === "text") ?? [])
    : [];
  const commitPaths = eligible
    .filter((file) => selected.has(file.path))
    .map((file) => file.path);
  const canCommit =
    writable &&
    staged &&
    !!review?.branch?.startsWith("refs/heads/") &&
    !busy &&
    commitPaths.length > 0 &&
    commitPaths.length <= 128 &&
    !!message.trim() &&
    message.length <= 8192;
  const chosenRemote = remotes.find((item) => item.name === remote);
  const canFetch =
    writable &&
    !!capabilities?.fetchEnabled &&
    !!chosenRemote?.fetchAvailable &&
    !busy;
  useEffect(
    () => () => {
      current.current = "";
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    onWritableChange(fileEnabled);
  }, [fileEnabled, onWritableChange]);
  useEffect(() => {
    onDialogChange(!!preview || pushDialog);
    return () => onDialogChange(false);
  }, [preview, pushDialog, onDialogChange]);
  useEffect(() => {
    setPreview(null);
  }, [context, path]);
  useEffect(() => {
    pending.current = null;
    setBusy(false);
    setError("");
    setStatus("");
  }, [context]);
  useEffect(() => {
    setSelected(
      (previous) =>
        new Set(
          [...previous].filter((path) =>
            review?.files.some((file) => file.path === path),
          ),
        ),
    );
  }, [review]);
  useEffect(() => {
    let alive = true;
    setCapabilities(null);
    setRemotes([]);
    setComparisonDestinations([]);
    if (!repository) return;
    void Promise.all([
      api<GitCapabilities>(`${prefix}/capabilities`),
      api<GitRemotesResponse & ComparisonPushDestinationsResponse>(
        `${prefix}/remotes`,
      ),
    ])
      .then(([capabilities, response]) => {
        if (!alive) return;
        setCapabilities(capabilities);
        setRemotes(response.remotes ?? []);
        setComparisonDestinations(response.comparisonDestinations ?? []);
        setRemote((previous) =>
          response.remotes?.some((item) => item.name === previous)
            ? previous
            : (response.remotes?.[0]?.name ?? ""),
        );
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [repository?.id, review?.id]);
  async function execute<T>(
    request: () => Promise<T>,
    success: (result: T) => void,
  ) {
    if (pending.current) return;
    const token = current.current,
      operation = {};
    pending.current = operation;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await request();
      if (current.current === token && pending.current === operation)
        success(result);
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
  function change(action: "stage" | "unstage", hunkIndex?: number) {
    if (
      !fileEnabled ||
      !review ||
      (hunkIndex !== undefined &&
        (review.mode !== (action === "stage" ? "working" : "staged") ||
          file?.oldPath))
    )
      return;
    void execute(
      () =>
        api<GitActionResult>(`${prefix}/git`, "POST", {
          reviewId: review.id,
          action,
          path,
          ...(hunkIndex === undefined ? {} : { hunkIndex }),
        }),
      (result) => {
        setStatus(
          result.changed
            ? `${action === "stage" ? "Staged" : "Unstaged"} ${path}`
            : `No index changes for ${path}`,
        );
        if (result.changed) onRefresh();
      },
    );
  }
  function discard() {
    if (!fileEnabled || !review || !repository) return;
    const selectedPath = path;
    void execute(
      () =>
        api<DiscardPreview>(`${prefix}/discard-preview`, "POST", {
          reviewId: review.id,
          path,
        }),
      (result) => {
        if (currentPath.current !== selectedPath) return;
        if (
          result.path !== selectedPath ||
          result.target.repositoryId !== repository.id ||
          result.target.worktreeRoot !== repository.root ||
          result.target.gitDir !== repository.gitDir ||
          result.target.commonDir !== repository.commonDir ||
          result.target.head !== review.head ||
          result.target.branch !== review.branch ||
          result.target.reviewFingerprint !== review.fingerprint ||
          !["restore-index", "delete-untracked"].includes(result.operation)
        ) {
          setError(
            "Discard preview does not match the current target. Refresh before retrying.",
          );
          return;
        }
        setPreview(result);
      },
    );
  }
  function confirmDiscard() {
    if (!preview || !writable || busy || currentPath.current !== preview.path)
      return;
    void execute(
      () =>
        api<GitActionResult>(`${prefix}/discard`, "POST", {
          previewId: preview.previewId,
          confirmed: true,
        }),
      (result) => {
        setPreview(null);
        setStatus(
          result.changed
            ? `Discarded unstaged changes in ${preview.path}`
            : `No worktree changes for ${preview.path}`,
        );
        if (result.changed) onRefresh();
      },
    );
  }
  function commit() {
    if (!canCommit || !review) return;
    const revision = messageRevision.current;
    void execute(
      () =>
        api<GitCommitResult>(`${prefix}/commit`, "POST", {
          reviewId: review.id,
          paths: commitPaths,
          message,
        }),
      (result) => {
        if (revision === messageRevision.current) setMessage("");
        setSelected(
          (previous) =>
            new Set(
              [...previous].filter((path) => !commitPaths.includes(path)),
            ),
        );
        setStatus(`Committed ${result.commit.slice(0, 8)}`);
        onRefresh();
      },
    );
  }
  function fetchRemote() {
    if (!canFetch || !review) return;
    void execute(
      () =>
        api<{ ok: true; remote: string }>(`${prefix}/fetch`, "POST", {
          reviewId: review.id,
          remote,
          expectedHead: review.head,
        }),
      (result) => {
        setStatus(`Fetched ${result.remote}`);
        onRefresh();
      },
    );
  }
  useImperativeHandle(ref, () => ({
    stage: (index) => change("stage", index),
    unstage: (index) => change("unstage", index),
    discard,
    commit,
    fetch: fetchRemote,
    close: () => {
      setPreview(null);
      pushActions.current?.close();
    },
  }));
  return (
    <section className="git-actions agent-panel" aria-label="Git actions">
      <strong>Git</strong>
      {review?.historical ? (
        <small>Historical comparison is read-only</small>
      ) : review?.executionEligible === false ? (
        <small>
          Worktree actions require the checked-out branch. Manual Push uses its
          own exact selected-branch confirmation.
        </small>
      ) : capabilities?.reason ? (
        <small>{capabilities.reason}</small>
      ) : (
        <small>Exact current file · explicit Git actions</small>
      )}
      <div className="git-file-actions">
        <button disabled={!fileEnabled} onClick={() => change("stage")}>
          Stage file
        </button>
        <button disabled={!fileEnabled} onClick={() => change("unstage")}>
          Unstage file
        </button>
        <button disabled={!fileEnabled} onClick={discard}>
          Discard file
        </button>
      </div>
      {!staged && (
        <small>
          Switch to Staged to select index changes for a commit. Stage hunks in
          Working; unstage hunks in Staged.
        </small>
      )}
      {staged && (
        <div className="commit-panel">
          <strong>Selected staged changes</strong>
          {eligible.map((file) => (
            <label key={file.path}>
              <input
                type="checkbox"
                aria-label={`Commit ${file.path}`}
                checked={selected.has(file.path)}
                disabled={!writable || busy}
                onChange={(e) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (e.target.checked) next.add(file.path);
                    else next.delete(file.path);
                    return next;
                  })
                }
              />
              <span>{file.path}</span>
            </label>
          ))}
          <label htmlFor="commit-message">Commit message</label>
          <textarea
            id="commit-message"
            aria-label="Commit message"
            value={message}
            maxLength={8192}
            onChange={(e) => {
              messageRevision.current++;
              setMessage(e.target.value);
            }}
          />
          <small>
            Only checked current-index paths are committed. Other staged and
            unstaged changes stay in place. Requires a local branch and Git
            identity.
          </small>
          <button className="primary" disabled={!canCommit} onClick={commit}>
            Commit selected
          </button>
        </div>
      )}
      <strong>Remotes</strong>
      <small>
        Metadata is offline. Fetch uses your existing local HTTPS/SSH
        authentication and changes remote-tracking refs.
      </small>
      {remotes.length ? (
        <>
          <label>
            Remote
            <select
              aria-label="Fetch remote"
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
            >
              {remotes.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {remotes.map((item) => (
            <div className="remote-metadata" key={item.name}>
              <strong>{item.name}</strong>
              <span>{item.url}</span>
              <small>{item.transport}</small>
              {item.reason && <small>{item.reason}</small>}
            </div>
          ))}
          <button disabled={!canFetch} onClick={fetchRemote}>
            Fetch {remote}
          </button>
        </>
      ) : (
        <small>No configured remotes</small>
      )}
      <PushActions
        ref={pushActions}
        repository={repository}
        review={review}
        enabled={reviewReady && !!capabilities?.writesEnabled && !busy}
        remotes={remotes.map((item) => item.name)}
        comparisonDestinations={comparisonDestinations}
        onRefresh={onRefresh}
        onDialogChange={setPushDialog}
      />
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {preview &&
        createPortal(
          <Modal label="Confirm discard" onClose={() => setPreview(null)}>
            <h2>Confirm discard</h2>
            <p>
              {preview.operation === "delete-untracked"
                ? "The untracked file will be deleted. Git cannot restore it."
                : "Your unstaged changes will be replaced by the staged/index version."}
            </p>
            <dl className="exact-target">
              <dt>Worktree</dt>
              <dd>{preview.target.worktreeRoot}</dd>
              <dt>Path</dt>
              <dd>{preview.path}</dd>
              <dt>Branch</dt>
              <dd>{preview.target.branch ?? "Detached HEAD"}</dd>
              <dt>HEAD</dt>
              <dd>{preview.target.head}</dd>
              <dt>Git directory</dt>
              <dd>{preview.target.gitDir}</dd>
              <dt>Common directory</dt>
              <dd>{preview.target.commonDir}</dd>
              <dt>Review fingerprint</dt>
              <dd>{preview.target.reviewFingerprint}</dd>
            </dl>
            <div className="compose-actions">
              <button onClick={() => setPreview(null)}>Cancel</button>
              <button
                className="danger"
                disabled={busy || !writable}
                onClick={confirmDiscard}
              >
                Confirm discard
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </Modal>,
          document.body,
        )}
    </section>
  );
});
