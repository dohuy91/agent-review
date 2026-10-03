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
  RepositoryRestoreError,
  RepositorySelectionResult,
  SkillMetadata,
} from "../../../packages/shared/src/index.js";
import { api, bootstrap } from "./api.js";
import DiffView, { type Selection } from "./components/DiffView.js";
import Sidebar from "./components/Sidebar.js";
import BranchCombobox from "./components/BranchCombobox.js";
import BranchSwitchDialog from "./components/BranchSwitchDialog.js";
import RepositoryPicker from "./components/RepositoryPicker.js";
import type { BranchSwitchResult } from "../../../packages/shared/src/branch-switch.js";
import Modal from "./components/Modal.js";
import CommentDrawer from "./components/CommentDrawer.js";
import CommentComposer from "./components/CommentComposer.js";
import CommentThread from "./components/CommentThread.js";
import CollapsiblePanel from "./components/CollapsiblePanel.js";
import { useCommentDraft } from "./commentDraft.js";
import PaneSeparator from "./components/PaneSeparator.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { useTheme } from "./useTheme.js";
import type { PaneWidths } from "./paneLayout.js";
import AgentPanel from "./components/AgentPanel.js";
import GitActions, { type GitActionsHandle } from "./components/GitActions.js";
import Preferences from "./components/Preferences.js";
import {
  loadPreferences,
  savePreferences,
  shortcutAction,
  type Shortcuts,
  type ThemePreference,
} from "./preferences.js";
export default function App() {
  const initialPreferences = useRef(loadPreferences()).current;
  const workspace = useRef<HTMLDivElement>(null);
  const panes = usePaneLayout(workspace, initialPreferences.paneWidths);
  const savedPaneWidths = useRef(panes.preferredWidths);
  const [shortcuts, setShortcuts] = useState(initialPreferences.shortcuts);
  const [theme, setTheme] = useState(initialPreferences.theme);
  const dark = useTheme(theme);
  const [registrationErrors, setRegistrationErrors] = useState<
    RepositoryRestoreError[]
  >([]);
  const [gitDialogOpen, setGitDialogOpen] = useState(false),
    [gitFileEnabled, setGitFileEnabled] = useState(false);
  const gitActions = useRef<GitActionsHandle>(null);
  const navigation = useRef({
    revision: 0,
    generation: 0,
    alive: true,
    target: "",
  });
  type NavigationIntent = { generation: number; revision: number };
  function beginNavigation(id: string): NavigationIntent {
    const state = navigation.current;
    state.generation++;
    state.revision++;
    state.target = id;
    return { generation: state.generation, revision: state.revision };
  }
  function currentNavigation(intent: NavigationIntent) {
    return (
      navigation.current.alive &&
      intent.generation === navigation.current.generation
    );
  }
  function navigationHeaders(revision = navigation.current.revision) {
    return { "X-Review-Navigation": String(revision) };
  }
  async function persistSelection(id: string, intent: NavigationIntent) {
    let revision = intent.revision;
    for (
      let attempts = 0;
      attempts < 3 && currentNavigation(intent);
      attempts++
    ) {
      const result = await api<RepositorySelectionResult>(
        `/repositories/${encodeURIComponent(id)}/selection`,
        "PUT",
        {},
        navigationHeaders(revision),
      );
      if (!currentNavigation(intent)) return;
      if (result.accepted !== false) {
        if (revision !== intent.revision) {
          if (liveReview.current || review) liveHandler.current();
          else setRefresh((value) => value + 1);
        }
        return;
      }
      revision =
        Math.max(navigation.current.revision, result.navigationRevision ?? 0) +
        1;
      navigation.current.revision = revision;
    }
    if (currentNavigation(intent))
      throw new Error(
        "Repository navigation changed in another window. Refresh before retrying.",
      );
  }
  const repositoryContexts = useRef(
    new Map<
      string,
      { base: string; mode: ReviewMode; target?: string | null }
    >(),
  );
  const [repositories, setRepositories] = useState<Repository[]>([]),
    [repoId, setRepoId] = useState(""),
    [branches, setBranches] = useState<string[]>([]),
    [remoteBranches, setRemoteBranches] = useState<string[]>([]),
    [checkoutBranch, setCheckoutBranch] = useState<string | null>(null),
    [target, setTarget] = useState(""),
    [advancedBase, setAdvancedBase] = useState(true),
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
    [installedSkills, setInstalledSkills] = useState<SkillMetadata[]>([]),
    [selection, setSelection] = useState<Selection | null>(null),
    [creating, setCreating] = useState(false),
    [commentSurface, setCommentSurface] = useState<"sidebar" | "inline">(
      "sidebar",
    ),
    [draftTarget, setDraftTarget] = useState<Selection | null>(null),
    [split, setSplit] = useState(initialPreferences.split),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [rail, setRail] = useState(false),
    [panel, setPanel] = useState(false),
    [help, setHelp] = useState(false),
    [profileOpen, setProfileOpen] = useState(false),
    [agentDialogOpen, setAgentDialogOpen] = useState(false),
    [registerOpen, setRegisterOpen] = useState(false),
    [registrationBusy, setRegistrationBusy] = useState(false),
    [registrationError, setRegistrationError] = useState(""),
    [branchSwitchTarget, setBranchSwitchTarget] = useState<string | null>(null),
    [branchSwitchNotice, setBranchSwitchNotice] = useState(""),
    [scope, setScope] = useState<ProfileScope>("project"),
    [locator, setLocator] = useState(""),
    [digest, setDigest] = useState(""),
    [refresh, setRefresh] = useState(0),
    [draftRevision, setDraftRevision] = useState(0),
    [markBusy, setMarkBusy] = useState(false),
    [rangeStale, setRangeStale] = useState(false),
    [watchStatus, setWatchStatus] = useState("Connecting live updates…");
  const liveReview = useRef<ReviewObservation | null>(null),
    liveHandler = useRef<() => Promise<ReviewObservation | null>>(
      async () => null,
    ),
    scrollRestore = useRef<number | null>(null);
  const epoch = useRef(0),
    branchSwitchBusy = useRef(false),
    fileEpoch = useRef(0),
    hunk = useRef(-1),
    markPending = useRef<object | null>(null),
    draftEpoch = useRef(0);
  useEffect(
    () => () => {
      navigation.current.alive = false;
      navigation.current.generation++;
      epoch.current++;
      fileEpoch.current++;
      draftEpoch.current++;
      markPending.current = null;
    },
    [],
  );
  const selectionContext = useRef<{
    reviewId: string;
    path: string;
    target: string;
  } | null>(null);
  const canSelect =
    !diffPending &&
    !!review &&
    diff?.reviewId === review.id &&
    diff.path === path;
  const currentSelection = canSelect ? selection : null;
  const modalOpen =
    help ||
    profileOpen ||
    registerOpen ||
    agentDialogOpen ||
    gitDialogOpen ||
    !!branchSwitchTarget;
  function resetDraft() {
    setRangeStale(false);
    draftEpoch.current++;
    setDraftRevision((v) => v + 1);
    setCreating(false);
    setDraftTarget(null);
    setCommentSurface("sidebar");
  }
  function closeModal() {
    if (branchSwitchBusy.current) return;
    setBranchSwitchTarget(null);
    setHelp(false);
    setProfileOpen(false);
    if (registerOpen) {
      const intent = beginNavigation(repoId);
      if (repoId)
        void persistSelection(repoId, intent).catch((e) => {
          if (currentNavigation(intent)) fail(e);
        });
      // Dismissal supersedes a pending registration/review intent. Reissue the
      // displayed comparison at the new revision so durable context agrees.
      if (repoId) {
        if (review && !review.historical) liveHandler.current();
        else setRefresh((value) => value + 1);
      }
    }
    setRegisterOpen(false);
    gitActions.current?.close();
  }
  const repository = repositories.find((r) => r.id === repoId);
  const prefix = `/repositories/${encodeURIComponent(repoId)}`;
  const canonicalBranch = (branch: string | null | undefined) =>
    branch
      ? branch.startsWith("refs/heads/")
        ? branch
        : `refs/heads/${branch}`
      : "";
  const checkedOutRef = canonicalBranch(checkoutBranch ?? repository?.branch);
  const otherTarget = !!target && target !== checkedOutRef;
  const selectedTarget = review?.historical
    ? (review.targetRef ?? canonicalBranch(review.branch))
    : target || checkedOutRef;
  const targetOptions =
    branches.includes(selectedTarget) || !selectedTarget
      ? branches
      : [...branches, selectedTarget];
  function applyBranches(response: BranchesResponse) {
    setBranches(
      (response.localBranches ?? response.branches ?? []).map((branch) =>
        canonicalBranch(branch),
      ),
    );
    setRemoteBranches(response.remoteBranches ?? []);
    setCheckoutBranch(response.current ?? null);
  }
  function reviewQuery() {
    return new URLSearchParams({ base, mode, ...(target ? { target } : {}) });
  }
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
    const generation = navigation.current.generation;
    let initialIntent: NavigationIntent | undefined;
    void bootstrap()
      .then(() => api<RepositoriesResponse>("/repositories"))
      .then(async (r) => {
        if (!alive) return;
        setRepositories((previous) => [
          ...previous,
          ...r.repositories.filter(
            (repo) => !previous.some((item) => item.id === repo.id),
          ),
        ]);
        if (generation !== navigation.current.generation) return;
        setRegistrationErrors(r.errors ?? []);
        repositoryContexts.current = new Map(Object.entries(r.contexts ?? {}));
        navigation.current.revision = Math.max(
          navigation.current.revision,
          r.navigationRevision ?? 0,
        );
        const id = r.selectedRepositoryId || r.repositories[0]?.id || "";
        initialIntent = beginNavigation(id);
        if (id) await persistSelection(id, initialIntent);
        if (!alive || !currentNavigation(initialIntent)) return;
        setBase(r.base || "HEAD");
        setAdvancedBase(!r.base?.startsWith("refs/remotes/"));
        setTarget(r.target || "");
        setMode(r.mode || "full");
        setRepoId(id);
      })
      .catch((e) => {
        if (
          alive &&
          (initialIntent
            ? currentNavigation(initialIntent)
            : generation === navigation.current.generation)
        )
          fail(e);
      });
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
      api<BranchesResponse>(`${prefix}/branches`).then((response) => {
        if (request === epoch.current) applyBranches(response);
        return response;
      }),
      api<ReviewObservation>(
        historicalId
          ? `${prefix}/history/${encodeURIComponent(historicalId)}/review`
          : `${prefix}/review?${reviewQuery()}`,
        "GET",
        undefined,
        navigationHeaders(),
      ),
    ])
      .then(async ([b, o]) => {
        const m = await metadata(o);
        if (request !== epoch.current) return;
        applyBranches(b);
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
  }, [repoId, base, mode, target, historicalId, refresh]);
  liveHandler.current = async () => {
    if (!review || review.historical) return null;
    const request = ++epoch.current;
    const fileRequest = ++fileEpoch.current;
    setDiffPending(true);
    selectionContext.current = null;
    draftEpoch.current++;
    setSelection(null);
    setRangeStale(true);
    setLoading(true);
    const selectedPath = path;
    const scroll = document.querySelector(".diff-scroll")?.scrollTop || 0;
    return Promise.all([
      api<BranchesResponse>(`${prefix}/branches`).then((response) => {
        if (request === epoch.current && fileRequest === fileEpoch.current)
          applyBranches(response);
        return response;
      }),
      api<ReviewObservation>(
        historicalId
          ? `${prefix}/history/${encodeURIComponent(historicalId)}/review`
          : `${prefix}/review?${reviewQuery()}`,
        "GET",
        undefined,
        navigationHeaders(),
      ),
    ])
      .then(async ([b, o]) => {
        const m = await metadata(o);
        if (request !== epoch.current || fileRequest !== fileEpoch.current)
          return null;
        draftEpoch.current++;
        setSelection(null);
        setRangeStale(true);
        liveReview.current = o;
        applyBranches(b);
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
        return o;
      })
      .catch((e) => {
        if (request === epoch.current) fail(e);
        return null;
      })
      .finally(() => {
        if (request === epoch.current) setLoading(false);
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
      review.historical ||
      !canSelect ||
      rangeStale ||
      !draftTarget ||
      selectionContext.current?.reviewId !== review.id ||
      selectionContext.current.path !== path ||
      selectionContext.current.target !== target
    )
      return false;
    const generation = epoch.current,
      draft = draftEpoch.current;
    try {
      await api(`${prefix}/comments`, "POST", {
        reviewId: review.id,
        path,
        side: draftTarget.side,
        startLine: draftTarget.startLine,
        endLine: draftTarget.endLine,
        body,
        severity,
      });
      const current = await updateComments(generation);
      return current && draft === draftEpoch.current;
    } catch (e) {
      if (generation === epoch.current && draft === draftEpoch.current) fail(e);
      return false;
    }
  }
  async function updateComment(id: string, patch: unknown) {
    if (!review || review.historical || loading) return false;
    const generation = epoch.current;
    try {
      await api(
        `${prefix}/comments/${id}?${new URLSearchParams({ reviewId: review.id })}`,
        "PATCH",
        patch,
      );
      return await updateComments(generation);
    } catch (e) {
      if (generation === epoch.current) fail(e);
      return false;
    }
  }
  async function deleteComment(id: string) {
    if (!review || review.historical || loading) return;
    const generation = epoch.current;
    try {
      await api(
        `${prefix}/comments/${id}?${new URLSearchParams({ reviewId: review.id })}`,
        "DELETE",
      );
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
  const draft = useCommentDraft({
    revision: draftRevision,
    onSave: saveComment,
    onUpdate: updateComment,
    onComplete: () => setCreating(false),
  });
  const composing = creating || !!draft.editing;
  // A disappearing/refreshed inline anchor must never hide the unsaved body.
  useEffect(() => {
    if (composing && (rangeStale || !canSelect)) setCommentSurface("sidebar");
  }, [composing, rangeStale, canSelect]);
  function addComment(surface: "sidebar" | "inline" = "sidebar") {
    if (review?.historical) return;
    if (!creating || draft.editing) {
      draftEpoch.current++;
      setDraftRevision((v) => v + 1);
      setDraftTarget(currentSelection);
      setCreating(true);
    }
    setCommentSurface(surface);
    if (surface === "sidebar") setPanel(true);
  }
  function editComment(
    comment: AttachedComment,
    surface: "sidebar" | "inline",
  ) {
    if (review?.historical) return;
    draftEpoch.current++;
    draft.edit(comment);
    setCreating(false);
    const range = comment.attachedRange;
    setDraftTarget(
      range &&
        comment.attachment === "current" &&
        (comment.attachedPath ?? comment.path) === path
        ? { side: comment.side, ...range, anchor: range.startLine }
        : null,
    );
    setCommentSurface(surface);
    if (surface === "sidebar") setPanel(true);
  }
  function retargetDraft() {
    if (!currentSelection || !review || !canSelect) return;
    draftEpoch.current++;
    setDraftTarget(currentSelection);
    selectionContext.current = { reviewId: review.id, path, target };
    setRangeStale(false);
  }
  const composer = (surface: "sidebar" | "inline") => (
    <CommentComposer
      draft={draft}
      selection={draftTarget}
      selectedRange={currentSelection}
      stale={!canSelect || rangeStale}
      pending={loading || !review}
      onRetarget={retargetDraft}
      onCancel={resetDraft}
      surface={surface}
      onSurface={
        draftTarget && canSelect && !rangeStale
          ? () => {
              setCommentSurface(surface === "inline" ? "sidebar" : "inline");
              if (surface === "inline") {
                setPanel(true);
              }
            }
          : undefined
      }
    />
  );
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
  function persistPreferences(values: {
    shortcuts?: Shortcuts;
    theme?: ThemePreference;
    split?: boolean;
    paneWidths?: PaneWidths;
  }) {
    savePreferences({
      version: 1,
      shortcuts,
      theme,
      split,
      paneWidths: panes.preferredWidths,
      ...values,
    });
  }
  useEffect(() => {
    const previous = savedPaneWidths.current;
    if (
      previous.left === panes.preferredWidths.left &&
      previous.right === panes.preferredWidths.right
    )
      return;
    savedPaneWidths.current = panes.preferredWidths;
    try {
      persistPreferences({ paneWidths: panes.preferredWidths });
    } catch (e) {
      fail(e);
    }
  }, [panes.preferredWidths]);
  function selectRepository(id: string) {
    setBranchSwitchNotice("");
    const intent = beginNavigation(id);
    if (id !== repoId) {
      epoch.current++;
      fileEpoch.current++;
      setDiffPending(true);
      setLoading(true);
      selectionContext.current = null;
      repositoryContexts.current.set(repoId, {
        base,
        mode,
        target: target || null,
      });
      const context = repositoryContexts.current.get(id),
        next = repositories.find((item) => item.id === id);
      setHistoricalId(null);
      setRepoId(id);
      setRail(false);
      setBase(
        context?.base ??
          (next?.projectId === repository?.projectId ? base : "HEAD"),
      );
      setMode(context?.mode ?? "full");
      setTarget(context?.target || "");
      setAdvancedBase(!(context?.base ?? "HEAD").startsWith("refs/remotes/"));
      setCheckoutBranch(null);
    }
    void persistSelection(id, intent).catch((e) => {
      if (currentNavigation(intent)) fail(e);
    });
  }
  function chooseComparison(
    nextBase: string,
    nextMode: ReviewMode,
    id: string | null = null,
    nextTarget: string = target,
  ) {
    const intent = beginNavigation(repoId);
    epoch.current++;
    fileEpoch.current++;
    setDiffPending(true);
    setLoading(true);
    selectionContext.current = null;
    setHistoricalId(id);
    setBase(nextBase);
    setMode(nextTarget && nextTarget !== checkedOutRef ? "branch" : nextMode);
    setTarget(nextTarget);
    if (repoId)
      void persistSelection(repoId, intent).catch((e) => {
        if (currentNavigation(intent)) fail(e);
      });
  }
  function selectTarget(value: string) {
    if (!branches.includes(value) || loading) return;
    if (value === checkedOutRef) {
      if (target) chooseComparison(base, mode, null, "");
      return;
    }
    if (!review) return;
    setBranchSwitchTarget(value);
  }
  function completeBranchSwitch(result: BranchSwitchResult) {
    setBranchSwitchTarget(null);
    setCheckoutBranch(result.branch);
    setRepositories((current) =>
      current.map((item) =>
        item.id === repoId
          ? { ...item, branch: result.branch, head: result.head }
          : item,
      ),
    );
    setBranchSwitchNotice(
      result.stash
        ? `Switched to ${result.branch}. Retained stash ${result.stash.oid} from ${result.stash.sourceBranch}.`
        : result.commit
          ? `Switched to ${result.branch}. Saved commit ${result.commit}.`
          : `Switched to ${result.branch}.`,
    );
    chooseComparison(base, "branch", null, "");
    setRefresh((value) => value + 1);
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const action = shortcutAction(
        e,
        shortcuts,
        modalOpen || !!document.querySelector("[role=dialog]"),
      );
      if (!action) return;
      e.preventDefault();
      const actions = {
        nextFile: () => moveFile(1),
        previousFile: () => moveFile(-1),
        nextHunk: () => moveHunk(1),
        previousHunk: () => moveHunk(-1),
        comment: () => addComment(),
        reviewed: () => void mark(),
        help: () => setHelp(true),
        close: () => {
          if (modalOpen || document.querySelector("[role=dialog]"))
            closeModal();
          else {
            resetDraft();
            setPanel(false);
            setRail(false);
          }
        },
        stage: () => gitActions.current?.stage(),
        unstage: () => gitActions.current?.unstage(),
        discard: () => gitActions.current?.discard(),
        commit: () => gitActions.current?.commit(),
        fetch: () => gitActions.current?.fetch(),
      };
      actions[action]();
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [
    review,
    path,
    diff,
    reviewed,
    modalOpen,
    shortcuts,
    creating,
    draft.editing,
    selection,
    canSelect,
  ]);
  function refreshReview() {
    if (review && !review.historical) liveHandler.current();
    else setRefresh((value) => value + 1);
  }
  async function register(selectedRoot: string) {
    const intent = beginNavigation(repoId);
    setRegistrationBusy(true);
    setRegistrationError("");
    try {
      const r = await api<Repository>(
        "/repositories",
        "POST",
        { path: selectedRoot },
        navigationHeaders(intent.revision),
      );
      if (!navigation.current.alive) return;
      // Inventory may grow after dismissal; only the current intent may navigate.
      setRepositories((previous) => [
        ...previous.filter((repo) => repo.id !== r.id),
        r,
      ]);
      setRegistrationErrors((previous) =>
        previous.filter((error) => error.root !== r.root),
      );
      if (!currentNavigation(intent)) return;
      navigation.current.target = r.id;
      epoch.current++;
      fileEpoch.current++;
      setDiffPending(true);
      setLoading(true);
      selectionContext.current = null;
      repositoryContexts.current.set(repoId, {
        base,
        mode,
        target: target || null,
      });
      setHistoricalId(null);
      setBase(repository?.projectId === r.projectId ? base : "HEAD");
      setMode("full");
      setTarget("");
      setCheckoutBranch(null);
      setAdvancedBase(!base.startsWith("refs/remotes/"));
      setRepoId(r.id);
      setRegisterOpen(false);
      await persistSelection(r.id, intent);
    } catch (e) {
      if (currentNavigation(intent)) setRegistrationError((e as Error).message);
    } finally {
      if (currentNavigation(intent)) setRegistrationBusy(false);
    }
  }
  useEffect(() => {
    if (profileOpen) {
      setLocator(profiles?.profiles[scope]?.locator || "");
      setDigest(profiles?.profiles[scope]?.digest || "");
    }
  }, [profileOpen, scope, profiles]);
  useEffect(() => {
    if (!profileOpen) return;
    let alive = true;
    void api<{ skills: SkillMetadata[] }>("/skills")
      .then((response) => {
        if (alive) setInstalledSkills(response.skills || []);
      })
      .catch((e) => {
        if (alive) fail(e);
      });
    return () => {
      alive = false;
    };
  }, [profileOpen]);
  async function saveProfile(remove = false) {
    if (!review || review.historical) return;
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
          <button
            onClick={() => {
              setRegistrationError("");
              setRegistrationBusy(false);
              setRegisterOpen(true);
            }}
          >
            ＋ Open repository
          </button>
          <button
            disabled={!!review?.historical}
            onClick={() => setProfileOpen(true)}
          >
            Fix profiles
          </button>
          <label className="theme-preference">
            Theme
            <select
              value={theme}
              onChange={(event) => {
                const nextTheme = event.target.value as ThemePreference;
                setTheme(nextTheme);
                try {
                  persistPreferences({ theme: nextTheme });
                } catch (e) {
                  fail(e);
                }
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <button aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>
            ?
          </button>
        </div>
      </header>
      <div className="review-toolbar" inert={modalOpen}>
        <div className="context branch-comparison">
          <BranchCombobox
            label="Local target branch"
            value={selectedTarget}
            placeholder={
              selectedTarget
                ? "Search local branches"
                : "Detached worktree HEAD"
            }
            options={targetOptions.map((ref) => ({
              value: ref,
              disabled:
                !branches.includes(ref) || (!review && ref !== checkedOutRef),
              label: `${ref.replace(/^refs\/heads\//, "")}${ref === checkedOutRef ? " (checked out)" : ""}${!branches.includes(ref) ? " (unavailable)" : ""}`,
            }))}
            onChange={selectTarget}
            disabled={loading || (!review && !target)}
          />
          <span className="against">against</span>
          <BranchCombobox
            label="Remote base branch"
            value={remoteBranches.includes(base) ? base : ""}
            placeholder="Search remote branches"
            options={remoteBranches.map((ref) => ({
              value: ref,
              label: ref.replace(/^refs\/remotes\//, ""),
            }))}
            onChange={(ref) => {
              setAdvancedBase(false);
              chooseComparison(ref, mode);
            }}
          />
          <select
            aria-label="Review mode"
            value={mode}
            onChange={(e) =>
              chooseComparison(base, e.target.value as ReviewMode)
            }
          >
            <option value="full" disabled={otherTarget}>
              Full changes
            </option>
            <option value="branch">Branch</option>
            <option value="working" disabled={otherTarget}>
              Working tree
            </option>
            <option value="staged" disabled={otherTarget}>
              Staged
            </option>
          </select>
          <button
            aria-expanded={advancedBase}
            aria-controls="advanced-base"
            onClick={() => setAdvancedBase(!advancedBase)}
          >
            Advanced base
          </button>
          {!advancedBase && !remoteBranches.includes(base) && (
            <small>Advanced base: {base}</small>
          )}
          <label id="advanced-base" hidden={!advancedBase}>
            Advanced base
            <input
              aria-label="Base reference"
              value={base}
              onChange={(e) => chooseComparison(e.target.value, mode)}
              list="base-branches"
            />
          </label>
          <datalist id="base-branches">
            {[...branches, ...remoteBranches].map((ref) => (
              <option key={ref} value={ref} />
            ))}
          </datalist>
        </div>
        <button aria-label="Refresh review" onClick={refreshReview}>
          ↻
        </button>
      </div>
      <div
        className="workspace"
        ref={workspace}
        style={{ gridTemplateColumns: panes.gridTemplateColumns }}
        inert={modalOpen}
      >
        <Sidebar
          repositories={repositories}
          selected={repoId}
          onSelect={selectRepository}
          errors={registrationErrors}
          files={review?.files || []}
          selectedPath={path}
          reviewed={reviewed}
          comments={comments}
          loading={loading}
          onSelectFile={(selectedPath) => {
            setPath(selectedPath);
            setRail(false);
          }}
          onClose={() => setRail(false)}
        />
        <PaneSeparator
          side="left"
          label="Resize changed files pane"
          controls="project-pane diff-pane"
          value={panes.widths.left}
          min={panes.bounds.left.min}
          max={panes.bounds.left.max}
          onResize={(width) => panes.resizePane("left", width)}
          onReset={() => panes.resetPane("left")}
          disabled={!panes.desktop}
        />
        <main id="diff-pane">
          {(otherTarget || review?.executionEligible === false) && (
            <div
              className="comparison-note"
              role="status"
              aria-label="Comparison target status"
            >
              Comparing {selectedTarget.replace(/^refs\/heads\//, "")} without
              checkout. Working tree/index and agent actions require the
              checked-out branch{" "}
              {checkedOutRef.replace(/^refs\/heads\//, "") || "(detached)"}.
            </div>
          )}
          {branchSwitchNotice && (
            <div className="comparison-note" role="status">
              {branchSwitchNotice}
            </div>
          )}
          <div className="file-toolbar">
            <span className="file-title">
              ⌘ <strong>{path || "Review changes"}</strong>
            </span>
            <div className="view-toggle">
              <button
                className={!split ? "active" : ""}
                onClick={() => {
                  setSplit(false);
                  try {
                    persistPreferences({ split: false });
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Unified
              </button>
              <button
                className={split ? "active" : ""}
                onClick={() => {
                  setSplit(true);
                  try {
                    persistPreferences({ split: true });
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Split
              </button>
            </div>
            <button
              disabled={!path || !review || review.historical || markBusy}
              onClick={() => void mark()}
            >
              {reviewed.has(path) ? "✓ Reviewed" : "○ Mark reviewed"}
            </button>
            <button
              disabled={!!review?.historical}
              onClick={() => addComment()}
            >
              Add comment
            </button>
            <button className="mobile-panel" onClick={() => setRail(!rail)}>
              Files
            </button>
            <button className="mobile-panel" onClick={() => setPanel(!panel)}>
              Notes
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={refreshReview}>Refresh</button>
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
                hunkAction={
                  review &&
                  (review.mode === "working" || review.mode === "staged") &&
                  review.files.find(
                    (file) =>
                      file.path === path &&
                      file.kind === "text" &&
                      !file.oldPath &&
                      ["000000", "100644", "100755"].includes(file.oldMode) &&
                      ["000000", "100644", "100755"].includes(file.newMode),
                  )
                    ? {
                        label: review.mode === "working" ? "Stage" : "Unstage",
                        disabled:
                          !gitFileEnabled ||
                          !canSelect ||
                          !!review.historical ||
                          review.executionEligible === false,
                        run: (index) =>
                          review.mode === "working"
                            ? gitActions.current?.stage(index)
                            : gitActions.current?.unstage(index),
                      }
                    : undefined
                }
                inlineSelection={composing ? draftTarget : currentSelection}
                inlineContent={
                  composing &&
                  commentSurface === "inline" &&
                  draftTarget &&
                  !rangeStale &&
                  canSelect ? (
                    <div
                      data-testid="inline-comment-composer"
                      data-line={draftTarget.endLine}
                    >
                      {composer("inline")}
                    </div>
                  ) : undefined
                }
                onInlineComment={
                  canSelect && !review?.historical
                    ? () => addComment("inline")
                    : undefined
                }
                comments={comments}
                renderComment={(comment) => (
                  <CommentThread
                    comment={comment}
                    readOnly={!!review?.historical || loading}
                    onEdit={(c) => editComment(c, "inline")}
                    onUpdate={updateComment}
                    onDelete={deleteComment}
                  />
                )}
                onSelect={(s) => {
                  if (!canSelect || !review) return;
                  selectionContext.current = {
                    reviewId: review.id,
                    path,
                    target,
                  };
                  if (
                    !draft.editing &&
                    (!creating ||
                      !draft.body.trim() ||
                      !draftTarget ||
                      rangeStale)
                  ) {
                    draftEpoch.current++;
                    setDraftTarget(s);
                  }
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
                    : error && !review
                      ? "The comparison could not be loaded."
                      : repositories.length
                        ? "No changes in this comparison."
                        : "Open a repository to begin your review."}
              </div>
            )}
          </div>
          <footer>
            <span>
              {review?.historical ? "Historical read-only · " : ""}
              {review?.branch || repository?.branch || "Detached HEAD"} ·{" "}
              {(review?.head || repository?.head)?.slice(0, 8) || "—"}
            </span>
            <span>
              {selection
                ? `${selection.side} ${selection.startLine}–${selection.endLine}`
                : "Select a gutter line · Shift-click for a range"}
            </span>
            <button onClick={() => setHelp(true)}>Shortcuts ?</button>
          </footer>
        </main>
        <PaneSeparator
          side="right"
          label="Resize details pane"
          controls="details-pane"
          value={panes.widths.right}
          min={panes.bounds.right.min}
          max={panes.bounds.right.max}
          onResize={(width) => panes.resizePane("right", width)}
          onReset={() => panes.resetPane("right")}
          disabled={!panes.desktop}
        />
        <aside className="aux" id="details-pane">
          <div className="drawer-tabs">
            <button className="active" onClick={() => setPanel(true)}>
              Comments <span>{comments.length}</span>
            </button>
            <button className="mobile-close" onClick={() => setPanel(false)}>
              ×
            </button>
          </div>
          <div className="aux-scroll">
            {composing &&
              !review?.historical &&
              commentSurface === "sidebar" &&
              composer("sidebar")}
            {composing && commentSurface === "inline" && (
              <div className="inline-draft-summary">
                Draft is open below {draftTarget?.side} lines{" "}
                {draftTarget?.startLine}–{draftTarget?.endLine}
                <button
                  onClick={() => {
                    setCommentSurface("sidebar");
                    setPanel(true);
                  }}
                >
                  Show sidebar draft
                </button>
              </div>
            )}
            <CollapsiblePanel title="Review notes" count={comments.length}>
              <CommentDrawer
                comments={comments}
                path={path}
                onEdit={(comment) => editComment(comment, "sidebar")}
                onUpdate={updateComment}
                onDelete={deleteComment}
                readOnly={!!review?.historical || loading}
              />
            </CollapsiblePanel>
            <CollapsiblePanel title="Git actions">
              <GitActions
                key={repoId}
                ref={gitActions}
                repository={repository}
                review={review}
                path={path}
                diffReady={canSelect}
                reviewReady={!loading}
                onRefresh={() => liveHandler.current()}
                onDialogChange={setGitDialogOpen}
                onWritableChange={setGitFileEnabled}
              />
            </CollapsiblePanel>
            <CollapsiblePanel
              title="Fix with agent"
              count={
                comments.filter(
                  (c) => c.status === "open" && c.attachment === "current",
                ).length
              }
            >
              <AgentPanel
                repositoryId={repoId}
                reviewId={review?.id || ""}
                comments={comments}
                profile={profiles}
                onOpenProfiles={() => setProfileOpen(true)}
                onDialogChange={setAgentDialogOpen}
                readOnly={
                  !!review?.historical ||
                  loading ||
                  otherTarget ||
                  review?.executionEligible === false
                }
              />
            </CollapsiblePanel>
          </div>
        </aside>
      </div>
      {(help || profileOpen || registerOpen) && (
        <Modal onClose={closeModal}>
          {help ? (
            <Preferences
              shortcuts={shortcuts}
              onSave={(value) => {
                persistPreferences({ shortcuts: value });
                setShortcuts(value);
                setHelp(false);
              }}
            />
          ) : registerOpen ? (
            <RepositoryPicker
              onSelect={register}
              onCancel={closeModal}
              busy={registrationBusy}
              error={registrationError}
            />
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
                Installed fix skill
                <select
                  aria-label="Installed fix skill"
                  value={
                    installedSkills.some(
                      (skill) =>
                        skill.locator === locator && skill.digest === digest,
                    )
                      ? locator
                      : ""
                  }
                  onChange={(event) => {
                    const skill = installedSkills.find(
                      (item) => item.locator === event.target.value,
                    );
                    if (skill) {
                      setLocator(skill.locator);
                      setDigest(skill.digest);
                    }
                  }}
                >
                  <option value="">Choose installed skill</option>
                  {installedSkills.map((skill) => (
                    <option key={skill.locator} value={skill.locator}>
                      {skill.name}
                    </option>
                  ))}
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
      {branchSwitchTarget && review && (
        <BranchSwitchDialog
          key={`${repoId}:${branchSwitchTarget}`}
          repositoryId={repoId}
          reviewId={review.id}
          targetRef={branchSwitchTarget}
          onCancel={() => setBranchSwitchTarget(null)}
          onComplete={completeBranchSwitch}
          onBusyChange={(busy) => {
            branchSwitchBusy.current = busy;
          }}
          onSaved={async (failure) => {
            if (failure.stash || failure.commit)
              setBranchSwitchNotice(
                failure.stash
                  ? `Retained stash ${failure.stash.oid} from ${failure.stash.sourceBranch}. Branch has not switched.`
                  : `Saved commit ${failure.commit}. Branch has not switched.`,
              );
            const refreshed = await liveHandler.current();
            return refreshed?.id || null;
          }}
          onOpenRepository={selectRepository}
        />
      )}
    </div>
  );
}
