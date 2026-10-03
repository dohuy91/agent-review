import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  Repository,
  ReviewObservation,
} from "../../../../packages/shared/src/index.js";
import type {
  PushFailureOutcome,
  PushPreview,
  PushResult,
  ComparisonPushDestination,
} from "../../../../packages/shared/src/push.js";
import Modal from "./Modal.js";
import "./PushActions.css";

class PushRequestError extends Error {
  constructor(
    message: string,
    readonly outcome?: PushFailureOutcome,
  ) {
    super(message);
  }
}
async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new PushRequestError(
      typeof data.error === "string"
        ? data.error
        : `Push request failed (${response.status})`,
      ["not-pushed", "rejected", "uncertain"].includes(data.outcome)
        ? data.outcome
        : undefined,
    );
  return data;
}
export interface PushActionsHandle {
  close: () => void;
}
export function comparisonDestination(
  base: string | undefined,
  remotes: string[],
  destinations: ComparisonPushDestination[] = [],
) {
  if (!base?.startsWith("refs/remotes/")) return null;
  const matches = destinations.filter((item) => item.trackingRef === base);
  const unique = new Map(
    matches.map((item) => [`${item.remote}\0${item.destinationRef}`, item]),
  );
  if (unique.size !== 1) return null;
  const mapping = [...unique.values()][0]!;
  return remotes.includes(mapping.remote) &&
    mapping.destinationRef.startsWith("refs/heads/")
    ? { remote: mapping.remote, destinationRef: mapping.destinationRef }
    : null;
}
export default forwardRef<
  PushActionsHandle,
  {
    repository: Repository | undefined;
    review: ReviewObservation | null;
    enabled: boolean;
    compact?: boolean;
    defaultRemote?: string | null;
    remotes: string[];
    comparisonDestinations?: ComparisonPushDestination[];
    onRefresh: () => void;
    onDialogChange: (open: boolean) => void;
  }
>(function PushActions(
  {
    repository,
    review,
    enabled,
    compact = false,
    defaultRemote,
    remotes,
    comparisonDestinations = [],
    onRefresh,
    onDialogChange,
  },
  ref,
) {
  const localRef = review?.targetRef ?? review?.branch ?? "";
  const comparison = comparisonDestination(
    review?.baseRef,
    remotes,
    comparisonDestinations,
  );
  const comparisonKey = comparison
    ? `${comparison.remote}:${comparison.destinationRef}`
    : "";
  const preferredRemote = compact ? (defaultRemote && remotes.includes(defaultRemote) ? defaultRemote : "") : comparison?.remote ?? remotes[0] ?? "";
  const [menuOpen, setMenuOpen] = useState(false), [inspectNext, setInspectNext] = useState(false);
  const [remote, setRemote] = useState(preferredRemote),
    [destinationRef, setDestinationRef] = useState(localRef),
    [toComparison, setToComparison] = useState(false),
    [preview, setPreview] = useState<PushPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [expired, setExpired] = useState(false);
  const allowed =
    enabled &&
    !!repository &&
    !!review &&
    !review.historical &&
    localRef.startsWith("refs/heads/");
  const context = `${repository?.id ?? ""}:${review?.id ?? ""}:${review?.fingerprint ?? ""}:${review?.baseRef ?? ""}:${comparisonKey}:${toComparison}:${localRef}:${remote}:${destinationRef}:${allowed}`;
  const current = useRef(context),
    pending = useRef<object | null>(null);
  const pushing = useRef(false);
  current.current = context;
  const prefix = `/repositories/${encodeURIComponent(repository?.id ?? "")}`;
  useEffect(() => {
    setRemote((previous) =>
      remotes.includes(previous) ? previous : (remotes[0] ?? ""),
    );
  }, [remotes.join("\0")]);
  useEffect(() => {
    setToComparison(false);
    setDestinationRef(localRef);
    setRemote(preferredRemote);
  }, [repository?.id, localRef, review?.baseRef, comparisonKey, preferredRemote]);
  useEffect(() => {
    pending.current = null;
    pushing.current = false;
    setBusy(false);
    setPreview(null);
    setError("");
    setStatus("");
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
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Math.min(remaining, 2 ** 31 - 1)),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  function close() {
    if (!pushing.current) {
      pending.current = null;
      setBusy(false);
    }
    setPreview(null);
  }
  useImperativeHandle(ref, () => ({ close }));
  function validPlan(plan: PushPreview) {
    const worktree = review?.worktree ?? repository;
    return (
      plan.repositoryId === repository?.id &&
      plan.reviewId === review?.id &&
      plan.reviewFingerprint === review?.fingerprint &&
      plan.localRef === localRef &&
      plan.sourceOid === review?.head &&
      plan.remote === remote &&
      plan.destinationRef === destinationRef &&
      plan.comparisonRef === (toComparison ? review?.baseRef : undefined) &&
      plan.worktree.branch === worktree?.branch &&
      plan.worktree.head === worktree?.head &&
      !!plan.previewId &&
      Number.isFinite(Date.parse(plan.expiresAt)) &&
      ["https", "ssh"].includes(plan.recipient.transport) &&
      !!plan.recipient.url &&
      Number.isSafeInteger(plan.outgoing.total) &&
      plan.outgoing.total >= 0 &&
      Array.isArray(plan.outgoing.commits) &&
      plan.outgoing.commits.length <= 50
    );
  }
  async function inspect() {
    if (
      !allowed ||
      busy ||
      pending.current ||
      !remotes.includes(remote) ||
      !destinationRef.startsWith("refs/heads/") ||
      destinationRef.length <= 11
    )
      return;
    const token = current.current,
      operation = {};
    pending.current = operation;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const plan = await request<PushPreview>(`${prefix}/push-preview`, {
        reviewId: review!.id,
        localRef,
        remote,
        destinationRef,
        ...(toComparison ? { comparisonRef: review!.baseRef } : {}),
        inspectRemote: true,
      });
      if (current.current !== token || pending.current !== operation) return;
      if (!validPlan(plan))
        throw new Error(
          "Push preview does not match the current target. Refresh before retrying.",
        );
      setPreview(plan);
    } catch (e) {
      if (current.current === token && pending.current === operation)
        setError(
          e instanceof PushRequestError
            ? e.message
            : e instanceof Error && e.message.includes("does not match")
              ? e.message
              : "Unable to inspect the remote. No push was requested.",
        );
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (!inspectNext) return;
    setInspectNext(false);
    void inspect();
  }, [inspectNext, context]);
  function inspectDefault() {
    setMenuOpen(false);
    setToComparison(false);
    setRemote(preferredRemote);
    setDestinationRef(localRef);
    setInspectNext(true);
  }
  function inspectComparison() {
    if (!comparison) return;
    setMenuOpen(false);
    setToComparison(true);
    setRemote(comparison.remote);
    setDestinationRef(comparison.destinationRef);
    setInspectNext(true);
  }
  async function confirm() {
    if (
      !preview ||
      !allowed ||
      busy ||
      pending.current ||
      expired ||
      preview.upToDate ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      !validPlan(preview)
    )
      return;
    const plan = preview,
      token = current.current,
      operation = {};
    pending.current = operation;
    pushing.current = true;
    setBusy(true);
    setPreview(null);
    setError("");
    setStatus("Push in progress…");
    try {
      const result = await request<PushResult>(`${prefix}/push`, {
        previewId: plan.previewId,
        confirmed: true,
      });
      if (current.current !== token || pending.current !== operation) return;
      if (
        !result.ok ||
        !["pushed", "up-to-date"].includes(result.outcome) ||
        result.remote !== plan.remote ||
        result.localRef !== plan.localRef ||
        result.sourceOid !== plan.sourceOid ||
        result.destinationRef !== plan.destinationRef ||
        result.recipient.url !== plan.recipient.url ||
        result.recipient.transport !== plan.recipient.transport
      )
        throw new Error("Unverifiable push response");
      setStatus(
        result.outcome === "up-to-date"
          ? "Remote branch is already up to date."
          : `Pushed ${plan.sourceOid.slice(0, 8)} to ${plan.remote} · ${plan.destinationRef}`,
      );
      onRefresh();
    } catch (e) {
      if (current.current === token && pending.current === operation) {
        setStatus("");
        setError(
          e instanceof PushRequestError &&
            e.outcome &&
            e.outcome !== "uncertain"
            ? e.message
            : "Push outcome is uncertain. Inspect the remote before trying another push. No automatic retry was made.",
        );
      }
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        pushing.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className={compact ? "push-actions push-compact" : "push-actions"} aria-label="Manual push">
      {compact ? <div className="split-push"><button title={preferredRemote ? `Push ${localRef} to ${preferredRemote}` : "Choose a default remote in Settings"} disabled={!allowed || busy || !preferredRemote} onClick={inspectDefault}>Push</button><button aria-label="Push options" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!allowed || busy} onClick={() => setMenuOpen(!menuOpen)}>⌄</button>{menuOpen && <div className="push-menu" role="menu"><button role="menuitem" disabled={!comparison} onClick={inspectComparison}>Push to comparison branch{comparison ? ` · ${comparison.remote}/${comparison.destinationRef.replace(/^refs\/heads\//, "")}` : " (unavailable)"}</button></div>}</div> : <>

      <strong>Push</strong>
      <small>
        Preview contacts the remote using your existing HTTPS/SSH
        authentication. Only confirmation sends commits; force-push is
        unavailable.
      </small>
      <small>Local branch: {localRef || "No local branch selected"}</small>
      <label>
        Push remote
        <select
          aria-label="Push remote"
          value={remote}
          disabled={busy || !allowed || toComparison}
          onChange={(e) => setRemote(e.target.value)}
        >
          {remotes.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="push-comparison-option">
        <input
          type="checkbox"
          aria-label="Push to comparison branch"
          checked={toComparison}
          disabled={busy || !allowed || !comparison}
          onChange={(event) => {
            const selected = event.target.checked;
            setToComparison(selected);
            if (selected && comparison) {
              setRemote(comparison.remote);
              setDestinationRef(comparison.destinationRef);
            } else setDestinationRef(localRef);
          }}
        />
        Push to comparison branch
      </label>
      {!comparison && (
        <small>
          The comparison option requires an unambiguous configured fetch mapping
          for the selected remote-tracking branch.
        </small>
      )}
      <label>
        Destination branch
        <input
          aria-label="Push destination branch"
          value={destinationRef}
          maxLength={1024}
          disabled={busy || !allowed || toComparison}
          onChange={(e) => setDestinationRef(e.target.value)}
          placeholder="refs/heads/main"
        />
      </label>
      <button
        disabled={
          !allowed ||
          busy ||
          !remotes.includes(remote) ||
          !destinationRef.startsWith("refs/heads/") ||
          destinationRef.length <= 11
        }
        onClick={() => void inspect()}
      >
        Preview push
      </button>
      </>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {preview &&
        createPortal(
          <Modal label="Confirm push" onClose={close}>
            <h2>Confirm push</h2>
            <p>
              This sends the selected committed branch to the recipient below.
              Uncommitted changes are not sent. Force-push is disabled.
            </p>
            <dl className="exact-target">
              <dt>Worktree</dt>
              <dd>{repository?.root}</dd>
              <dt>Local branch</dt>
              <dd>{preview.localRef}</dd>
              <dt>Exact commit</dt>
              <dd>{preview.sourceOid}</dd>
              <dt>Remote</dt>
              <dd>{preview.remote}</dd>
              <dt>Actual push recipient</dt>
              <dd>{preview.recipient.url}</dd>
              <dt>Destination branch</dt>
              <dd>{preview.destinationRef}</dd>
              <dt>Current remote commit</dt>
              <dd>{preview.destinationOid ?? "New branch"}</dd>
            </dl>
            <h3>Outgoing commits ({preview.outgoing.total})</h3>
            {preview.destinationRef !== preview.localRef && (
              <p className="push-warning">
                The destination branch name differs from the selected local
                branch.
              </p>
            )}
            {/^refs\/heads\/(?:main|master|trunk|develop|development|release(?:\/.*)?)$/.test(
              preview.destinationRef,
            ) && (
              <p className="push-warning">
                This is a commonly protected branch name. The remote’s branch
                protections still apply.
              </p>
            )}
            {preview.newBranch && <p>A new remote branch will be created.</p>}
            {preview.upToDate && (
              <p>The remote branch is already up to date.</p>
            )}
            <ol className="push-commits">
              {preview.outgoing.commits.map((commit) => (
                <li key={commit.oid}>
                  <code>{commit.oid.slice(0, 8)}</code>{" "}
                  <span>{commit.subject}</span>{" "}
                  <small>{commit.committedAt}</small>
                </li>
              ))}
            </ol>
            {preview.outgoing.truncated && (
              <p>Showing the newest 50 commits of {preview.outgoing.total}.</p>
            )}
            {expired && (
              <p role="alert">
                Preview expired. Close it and inspect the remote again.
              </p>
            )}
            <div className="compose-actions">
              <button onClick={close}>Cancel</button>
              <button
                className="primary"
                disabled={!allowed || busy || expired || preview.upToDate}
                onClick={() => void confirm()}
              >
                Confirm push
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </section>
  );
});
