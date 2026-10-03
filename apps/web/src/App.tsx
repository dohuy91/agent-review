import React, { useEffect, useLayoutEffect, useState, useRef } from "react";
import type {
  Repository,
  RepositoriesResponse,
  BranchesResponse,
  ReviewObservation,
  ReviewMode,
  FileDiff,
  CommentsResponse,
  AttachedComment,
  ReviewedResponse,
  ProfilesResponse,
  ProfileScope,
  CommentSeverity,
} from "../../../packages/shared/src/index.js";
import { api, bootstrap } from "./api.js";
import DiffView, { type Selection } from "./components/DiffView.js";
import Sidebar from "./components/Sidebar.js";
import ChangesPanel from "./components/ChangesPanel.js";
import Modal from "./components/Modal.js";
import CommentDrawer from "./components/CommentDrawer.js";
import HistoryPanel from "./components/HistoryPanel.js";
import AgentPanel from "./components/AgentPanel.js";
export default function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]),
    [repoId, setRepoId] = useState(""),
    [branches, setBranches] = useState<string[]>([]),
    [base, setBase] = useState("HEAD"),
    [historicalId, setHistoricalId] = useState<string | null>(null),
    [mode, setMode] = useState<ReviewMode>("full"),
    [review, setReview] = useState<ReviewObservation | null>(null),
    [path, setPath] = useState(""),
    [diff, setDiff] = useState<FileDiff | null>(null),
    [diffPending, setDiffPending] = useState(true),
    [comments, setComments] = useState<AttachedComment[]>([]),
    [reviewed, setReviewed] = useState<Set<string>>(new Set()),
    [profiles, setProfiles] = useState<ProfilesResponse | null>(null),
    [selection, setSelection] = useState<Selection | null>(null),
    [creating, setCreating] = useState(false),
    [tab, setTab] = useState<"changes" | "comments">("changes"),
    [split, setSplit] = useState(false),
    [dark, setDark] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [rail, setRail] = useState(false),
    [panel, setPanel] = useState(false),
    [help, setHelp] = useState(false),
    [profileOpen, setProfileOpen] = useState(false),
    [agentDialogOpen, setAgentDialogOpen] = useState(false),
    [registerOpen, setRegisterOpen] = useState(false),
    [root, setRoot] = useState(""),
    [scope, setScope] = useState<ProfileScope>("project"),
    [locator, setLocator] = useState(""),
    [digest, setDigest] = useState(""),
    [refresh, setRefresh] = useState(0),
    [draftRevision, setDraftRevision] = useState(0),
    [markBusy, setMarkBusy] = useState(false),
    [rangeStale, setRangeStale] = useState(false),
    [watchStatus, setWatchStatus] = useState("Connecting live updates…");
  const liveReview = useRef<ReviewObservation | null>(null),
    liveHandler = useRef<() => void>(() => {}),
    scrollRestore = useRef<number | null>(null);
  const epoch = useRef(0),
    fileEpoch = useRef(0),
    hunk = useRef(-1),
    markPending = useRef<object | null>(null),
    draftEpoch = useRef(0);
  const selectionContext = useRef<{ reviewId: string; path: string } | null>(
    null,
  );
  const canSelect =
    !diffPending &&
    !!review &&
    diff?.reviewId === review.id &&
    diff.path === path;
  const currentSelection = canSelect ? selection : null;
  const modalOpen = help || profileOpen || registerOpen || agentDialogOpen;
  function resetDraft() {
    setRangeStale(false);
    draftEpoch.current++;
    setDraftRevision((v) => v + 1);
    setCreating(false);
  }
  function closeModal() {
    setHelp(false);
    setProfileOpen(false);
    setRegisterOpen(false);
  }
  const repository = repositories.find((r) => r.id === repoId);
  const prefix = `/repositories/${encodeURIComponent(repoId)}`;
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }
  async function metadata(observation: ReviewObservation) {
    const [c, r, p] = await Promise.all([
      api<CommentsResponse>(`${prefix}/comments?reviewId=${observation.id}`),
      api<ReviewedResponse>(`${prefix}/reviewed?reviewId=${observation.id}`),
      api<ProfilesResponse>(`${prefix}/profiles?reviewId=${observation.id}`),
    ]);
    return { c, r, p };
  }
  useEffect(() => {
    let alive = true;
    void bootstrap()
      .then(() => api<RepositoriesResponse>("/repositories"))
      .then((r) => {
        if (alive) {
          setRepositories(r.repositories);
          setBase(r.base || "HEAD");
          setMode(r.mode || "full");
          setRepoId(r.selectedRepositoryId || r.repositories[0]?.id || "");
        }
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    setHistoricalId(null);
  }, [repoId]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    if (!repoId) return;
    const request = ++epoch.current;
    fileEpoch.current++;
    setLoading(true);
    markPending.current = null;
    setMarkBusy(false);
    setComments([]);
    setReviewed(new Set());
    setProfiles(null);
    setReview(null);
    setDiffPending(true);
    setDiff(null);
    setSelection(null);
    resetDraft();
    setError("");
    void Promise.all([
      api<BranchesResponse>(`${prefix}/branches`),
      api<ReviewObservation>(
        historicalId
          ? `${prefix}/history/${encodeURIComponent(historicalId)}/review`
          : `${prefix}/review?${new URLSearchParams({ base, mode })}`,
      ),
    ])
      .then(async ([b, o]) => {
        const m = await metadata(o);
        if (request !== epoch.current) return;
        setBranches(b.branches);
        setReview(o);
        setPath((previous) =>
          o.files.some((f) => f.path === previous)
            ? previous
            : o.files[0]?.path || "",
        );
        setComments(m.c.comments);
        setReviewed(
          new Set(m.r.files.filter((f) => f.reviewed).map((f) => f.path)),
        );
        setProfiles(m.p);
      })
      .catch((e) => {
        if (request === epoch.current) fail(e);
      })
      .finally(() => {
        if (request === epoch.current) setLoading(false);
      });
  }, [repoId, base, mode, historicalId, refresh]);
  liveHandler.current = () => {
    if (!review || review.historical) return;
    const request = ++epoch.current;
    const fileRequest = ++fileEpoch.current;
    setDiffPending(true);
    selectionContext.current = null;
    draftEpoch.current++;
    setSelection(null);
    setRangeStale(true);
    const selectedPath = path;
    const scroll = document.querySelector(".diff-scroll")?.scrollTop || 0;
    void api<ReviewObservation>(
      historicalId
        ? `${prefix}/history/${encodeURIComponent(historicalId)}/review`
        : `${prefix}/review?${new URLSearchParams({ base, mode })}`,
    )
      .then(async (o) => {
        const m = await metadata(o);
        if (request !== epoch.current || fileRequest !== fileEpoch.current)
          return;
        draftEpoch.current++;
        setSelection(null);
        setRangeStale(true);
        liveReview.current = o;
        scrollRestore.current = scroll;
        setReview(o);
        setComments(m.c.comments);
        setReviewed(
          new Set(m.r.files.filter((f) => f.reviewed).map((f) => f.path)),
        );
        setProfiles(m.p);
        // Keep selected path pinned even when it disappears; never move an unsaved body.
        if (!o.files.some((f) => f.path === selectedPath)) {
          setDiff(null);
          setError("Selected file disappeared. Choose a file explicitly.");
        }
      })
      .catch((e) => {
        if (request === epoch.current) fail(e);
      });
  };
  useEffect(() => {
    if (!repoId || typeof EventSource === "undefined") {
      setWatchStatus("Live updates unavailable");
      return;
    }
    const stream = new EventSource(`/api${prefix}/events`);
    stream.onopen = () => setWatchStatus("Live updates connected");
    stream.onerror = () =>
      setWatchStatus("Live updates disconnected; retrying");
    stream.onmessage = (e) => {
      try {
        const type = JSON.parse(e.data).type;
        if (type === "invalidate") liveHandler.current();
        else if (type === "unavailable")
          setWatchStatus("Live watch unavailable; refresh manually");
      } catch {
        setWatchStatus("Invalid live update");
      }
    };
    return () => stream.close();
  }, [repoId]);
  useLayoutEffect(() => {
    if (diff && scrollRestore.current !== null) {
      const el = document.querySelector(".diff-scroll");
      if (el) el.scrollTop = scrollRestore.current;
      scrollRestore.current = null;
    }
  }, [diff]);
  useEffect(() => {
    if (!review || !path) return;
    const request = ++fileEpoch.current;
    setDiffPending(true);
    const live = liveReview.current === review;
    liveReview.current = null;
    if (!live) {
      setDiff(null);
      setSelection(null);
      resetDraft();
      hunk.current = -1;
    }
    if (!review.files.some((f) => f.path === path)) return;
    void api<FileDiff>(
      `${prefix}/diff?${new URLSearchParams({ reviewId: review.id, path })}`,
    )
      .then((d) => {
        if (request === fileEpoch.current) {
          if (d.reviewId !== review.id || d.path !== path) {
            fail(new Error("File response does not match the current review"));
            return;
          }
          selectionContext.current = null;
          setSelection(null);
          setDiff(d);
          setDiffPending(false);
        }
      })
      .catch((e) => {
        if (request === fileEpoch.current) fail(e);
      });
  }, [review, path]);
  async function updateComments(generation: number) {
    if (!review || generation !== epoch.current) return false;
    const response = await api<CommentsResponse>(
      `${prefix}/comments?reviewId=${review.id}`,
    );
    if (generation !== epoch.current) return false;
    setComments(response.comments);
    return true;
  }
  async function saveComment(body: string, severity: CommentSeverity) {
    if (
      !review ||
      !currentSelection ||
      selectionContext.current?.reviewId !== review.id ||
      selectionContext.current.path !== path
    )
      return false;
    const generation = epoch.current,
      draft = draftEpoch.current;
    try {
      await api(`${prefix}/comments`, "POST", {
        reviewId: review.id,
        path,
        side: currentSelection.side,
        startLine: currentSelection.startLine,
        endLine: currentSelection.endLine,
        body,
        severity,
      });
      const current = await updateComments(generation);
      if (current && draft === draftEpoch.current) setCreating(false);
      return current && draft === draftEpoch.current;
    } catch (e) {
      if (generation === epoch.current) fail(e);
      return false;
    }
  }
  async function updateComment(id: string, patch: unknown) {
    const generation = epoch.current;
    try {
      await api(`${prefix}/comments/${id}`, "PATCH", patch);
      return await updateComments(generation);
    } catch (e) {
      if (generation === epoch.current) fail(e);
      return false;
    }
  }
  async function deleteComment(id: string) {
    const generation = epoch.current;
    try {
      await api(`${prefix}/comments/${id}`, "DELETE");
      await updateComments(generation);
    } catch (e) {
      if (generation === epoch.current) fail(e);
    }
  }
  async function mark() {
    if (!review || review.historical || !path || markPending.current) return;
    const generation = epoch.current,
      pending = {};
    markPending.current = pending;
    setMarkBusy(true);
    try {
      const response = await api<ReviewedResponse>(
        `${prefix}/reviewed`,
        "PUT",
        { reviewId: review.id, path, reviewed: !reviewed.has(path) },
      );
      if (generation === epoch.current)
        setReviewed(
          new Set(
            response.files
              .filter((file) => file.reviewed)
              .map((file) => file.path),
          ),
        );
    } catch (e) {
      if (generation === epoch.current) fail(e);
    } finally {
      if (markPending.current === pending) {
        markPending.current = null;
        if (generation === epoch.current) setMarkBusy(false);
      }
    }
  }
  function addComment() {
    if (review?.historical) return;
    draftEpoch.current++;
    setDraftRevision((v) => v + 1);
    setTab("comments");
    setCreating(true);
    setPanel(true);
  }
  function moveFile(delta: number) {
    if (review?.files.length) {
      const current = review.files.findIndex((f) => f.path === path);
      setPath(
        review.files[
          Math.max(0, Math.min(review.files.length - 1, current + delta))
        ].path,
      );
    }
  }
  function moveHunk(delta: number) {
    if (diff?.hunks.length) {
      hunk.current = Math.max(
        0,
        Math.min(diff.hunks.length - 1, hunk.current + delta),
      );
      document
        .getElementById(`hunk-${hunk.current}`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (e.key === "Escape") {
        e.preventDefault();
        if (modalOpen) {
          closeModal();
        } else {
          resetDraft();
          setPanel(false);
          setRail(false);
        }
        return;
      }
      if (modalOpen) return;
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (target instanceof Element &&
          target.closest(
            'input,textarea,select,[contenteditable="true"],.cm-editor',
          ))
      )
        return;
      const actions: Record<string, () => void> = {
        j: () => moveFile(1),
        k: () => moveFile(-1),
        n: () => moveHunk(1),
        p: () => moveHunk(-1),
        c: addComment,
        r: () => void mark(),
        "?": () => setHelp(true),
      };
      if (actions[e.key]) {
        e.preventDefault();
        actions[e.key]();
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [review, path, diff, reviewed, modalOpen]);
  async function register() {
    try {
      const r = await api<Repository>("/repositories", "POST", { path: root });
      setRepositories((previous) => [
        ...previous.filter((p) => p.id !== r.id),
        r,
      ]);
      setRepoId(r.id);
      setRegisterOpen(false);
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    if (profileOpen) {
      setLocator(profiles?.profiles[scope]?.locator || "");
      setDigest(profiles?.profiles[scope]?.digest || "");
    }
  }, [profileOpen, scope, profiles]);
  async function saveProfile(remove = false) {
    if (!review) return;
    const generation = epoch.current;
    try {
      const response = await api<ProfilesResponse>(
        `${prefix}/profiles`,
        "PUT",
        {
          reviewId: review.id,
          scope,
          profile: remove ? null : { locator, digest },
        },
      );
      if (generation === epoch.current) {
        setProfiles(response);
        setProfileOpen(false);
      }
    } catch (e) {
      if (generation === epoch.current) fail(e);
    }
  }
  return (
    <div
      className={`app ${rail ? "rail-open" : ""} ${panel ? "panel-open" : ""}`}
    >
      <header className="topbar" inert={modalOpen}>
        <button className="brand" onClick={() => setRail(!rail)}>
          <span className="brand-icon">▤</span> Agent Review
        </button>
        <span className="local-pill">● Local</span>
        <small role="status">{watchStatus}</small>
        <div className="top-actions">
          <button onClick={() => setRegisterOpen(true)}>
            ＋ Open repository
          </button>
          <button onClick={() => setProfileOpen(true)}>Fix profiles</button>
          <button aria-label="Toggle theme" onClick={() => setDark(!dark)}>
            {dark ? "☀" : "☾"}
          </button>
          <button aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>
            ?
          </button>
        </div>
      </header>
      <div className="workspace" inert={modalOpen}>
        <Sidebar
          repositories={repositories}
          selected={repoId}
          onSelect={(id) => {
            setRepoId(id);
            setRail(false);
          }}
          branches={branches}
          onBase={(base) => {
            setHistoricalId(null);
            setBase(base);
          }}
          onClose={() => setRail(false)}
        />
        <main>
          <div className="review-toolbar">
            <div className="context">
              <span>⑂</span>
              <select
                aria-label="Registered worktree"
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
              >
                {repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.branch || "Detached HEAD"} · {r.root.split("/").pop()}
                  </option>
                ))}
              </select>
              <span className="against">against</span>
              <input
                aria-label="Base reference"
                value={base}
                onChange={(e) => {
                  setHistoricalId(null);
                  setBase(e.target.value);
                }}
                list="base-branches"
              />
              <datalist id="base-branches">
                {branches.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              <select
                aria-label="Review mode"
                value={mode}
                onChange={(e) => {
                  setHistoricalId(null);
                  setMode(e.target.value as ReviewMode);
                }}
              >
                <option value="full">Full changes</option>
                <option value="branch">Branch</option>
                <option value="working">Working tree</option>
                <option value="staged">Staged</option>
              </select>
            </div>
            <button
              aria-label="Refresh review"
              onClick={() => setRefresh((v) => v + 1)}
            >
              ↻
            </button>
          </div>
          <div className="file-toolbar">
            <span className="file-title">
              ⌘ <strong>{path || "Review changes"}</strong>
            </span>
            <div className="view-toggle">
              <button
                className={!split ? "active" : ""}
                onClick={() => setSplit(false)}
              >
                Unified
              </button>
              <button
                className={split ? "active" : ""}
                onClick={() => setSplit(true)}
              >
                Split
              </button>
            </div>
            <button
              disabled={!path || !review || markBusy}
              onClick={() => void mark()}
            >
              {reviewed.has(path) ? "✓ Reviewed" : "○ Mark reviewed"}
            </button>
            <button disabled={!!review?.historical} onClick={addComment}>
              Add comment
            </button>
            <button className="mobile-panel" onClick={() => setPanel(!panel)}>
              Changes
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setRefresh((v) => v + 1)}>Refresh</button>
            </div>
          )}
          <div className="diff-scroll">
            {diff ? (
              <DiffView
                diff={diff}
                split={split}
                dark={dark}
                selection={currentSelection}
                disabled={!canSelect}
                onSelect={(s) => {
                  if (!canSelect || !review) return;
                  selectionContext.current = { reviewId: review.id, path };
                  setSelection(s);
                  setRangeStale(false);
                }}
              />
            ) : (
              <div className="empty hero-empty">
                {loading
                  ? "Loading comparison…"
                  : review?.files.length
                    ? "Loading file…"
                    : repositories.length
                      ? "No changes in this comparison."
                      : "Open a repository to begin your review."}
              </div>
            )}
          </div>
          <footer>
            <span>
              {review?.historical ? "Historical read-only · " : ""}
              {repository?.branch || "Detached HEAD"} ·{" "}
              {review?.head?.slice(0, 8) || "—"}
            </span>
            <span>
              {selection
                ? `${selection.side} ${selection.startLine}–${selection.endLine}`
                : "Select a gutter line · Shift-click for a range"}
            </span>
            <button onClick={() => setHelp(true)}>Shortcuts ?</button>
          </footer>
        </main>
        <aside className="aux">
          <div className="drawer-tabs">
            <button
              className={tab === "changes" ? "active" : ""}
              onClick={() => setTab("changes")}
            >
              Changes <span>{review?.files.length || 0}</span>
            </button>
            <button
              className={tab === "comments" ? "active" : ""}
              onClick={() => setTab("comments")}
            >
              Comments <span>{comments.length}</span>
            </button>
            <button className="mobile-close" onClick={() => setPanel(false)}>
              ×
            </button>
          </div>
          {tab === "changes" ? (
            <ChangesPanel
              files={review?.files || []}
              selected={path}
              reviewed={reviewed}
              onSelect={(p) => {
                setPath(p);
                setPanel(false);
              }}
            />
          ) : (
            <>
              {rangeStale && creating && (
                <p role="status">
                  Range changed; select current lines before saving.
                </p>
              )}
              <CommentDrawer
                key={`${repoId}:${path}`}
                draftRevision={draftRevision}
                comments={comments}
                path={path}
                selection={currentSelection}
                creating={creating}
                onSave={saveComment}
                onUpdate={updateComment}
                onDelete={deleteComment}
                onCancel={resetDraft}
              />
            </>
          )}
          <AgentPanel
            repositoryId={repoId}
            reviewId={review?.id || ""}
            comments={comments}
            profile={profiles}
            onProfile={setProfiles}
            onDialogChange={setAgentDialogOpen}
            readOnly={!!review?.historical}
          />
          <HistoryPanel
            repositoryId={repoId}
            reviewId={review?.id || ""}
            onSelect={(base, mode, id) => {
              setHistoricalId(id ?? null);
              setBase(base);
              setMode(mode);
            }}
          />
          <div className="profile-summary">
            <strong>Fix skill</strong>
            <span>
              {profiles?.effective?.locator || "No profile configured"}
            </span>
            <small>
              {profiles?.source
                ? `Inherited from ${profiles.source} · revision ${profiles.revision}`
                : "Select an installed fix skill"}
            </small>
            <button onClick={() => setProfileOpen(true)}>
              Configure profile
            </button>
          </div>
        </aside>
      </div>
      {(help || profileOpen || registerOpen) && (
        <Modal onClose={closeModal}>
          {help ? (
            <>
              <h2>Keyboard shortcuts</h2>
              {[
                ["j / k", "Next / previous file"],
                ["n / p", "Next / previous hunk"],
                ["c", "Add comment"],
                ["r", "Toggle reviewed"],
                ["Escape", "Close drawer or dialog"],
                ["?", "Show shortcuts"],
              ].map(([key, label]) => (
                <div className="shortcut" key={key}>
                  <kbd>{key}</kbd>
                  <span>{label}</span>
                </div>
              ))}
              <p>
                Click a line number to select it. Shift-click another number on
                the same side to select a range. Shortcuts leave typing alone.
              </p>
            </>
          ) : registerOpen ? (
            <>
              <h2>Open a local repository</h2>
              <p>Register an existing Git repository or worktree explicitly.</p>
              <label>
                Repository root
                <input
                  aria-label="Repository root"
                  value={root}
                  placeholder="/path/to/repository"
                  onChange={(e) => setRoot(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={!root.trim()}
                onClick={() => void register()}
              >
                Register root
              </button>
            </>
          ) : (
            <>
              <h2>Fix skill profiles</h2>
              <p>
                Project → branch → worktree and branch. Configuration is saved
                locally. Send starts the selected installed agent.
              </p>
              <div className="effective">
                <strong>
                  Effective: {profiles?.effective?.locator || "None"}
                </strong>
                <small>
                  Origin: {profiles?.source || "none"} · revision{" "}
                  {profiles?.revision || 0}
                </small>
                <code>{profiles?.effective?.digest || "No digest"}</code>
              </div>
              <label>
                Scope
                <select
                  aria-label="Profile scope"
                  value={scope}
                  onChange={(e) => {
                    const s = e.target.value as ProfileScope;
                    setScope(s);
                    setLocator(profiles?.profiles[s]?.locator || "");
                    setDigest(profiles?.profiles[s]?.digest || "");
                  }}
                >
                  <option value="project">Project default</option>
                  <option value="branch" disabled={!review?.branch}>
                    Branch override
                  </option>
                  <option value="worktree" disabled={!review?.branch}>
                    Worktree + branch override
                  </option>
                </select>
              </label>
              <label>
                Skill locator
                <input
                  aria-label="Skill locator"
                  value={locator}
                  onChange={(e) => setLocator(e.target.value)}
                />
              </label>
              <label>
                SHA-256 content digest
                <input
                  aria-label="Skill digest"
                  value={digest}
                  onChange={(e) => setDigest(e.target.value)}
                />
              </label>
              <div className="compose-actions">
                <button onClick={() => void saveProfile(true)}>
                  Remove override
                </button>
                <button
                  className="primary"
                  disabled={!locator.trim() || !/^[a-f0-9]{64}$/.test(digest)}
                  onClick={() => void saveProfile()}
                >
                  Save profile
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
