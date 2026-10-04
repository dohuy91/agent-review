import { createPortal } from "react-dom";
import Modal from "./Modal.js";
import "./AgentPanel.css";
import {
  unknownCodexProvider,
  type AgentAvailability,
} from "../../../../packages/shared/src/index.js";
import React, { useEffect, useRef, useState } from "react";
import type {
  AttachedComment,
  ProfilesResponse,
  SkillMetadata,
  AgentRun,
  AgentEvent,
  AgentAdapter,
} from "../../../../packages/shared/src/index.js";
import { api } from "../api.js";
import type {
  ProjectAgentContext,
  ProjectAgentSettingsResponse,
  ProjectAgentStart,
} from "../../../../packages/shared/src/project-settings.js";
export default function AgentPanel({
  repositoryId,
  reviewId,
  comments,
  profile,
  onOpenProfiles,
  onDialogChange,
  readOnly = false,
  compact = false,
  useProjectSettings = false,
  settingsRevision = 0,
}: {
  repositoryId: string;
  reviewId: string;
  comments: AttachedComment[];
  profile: ProfilesResponse | null;
  onProfile?: (p: ProfilesResponse) => void;
  onOpenProfiles?: () => void;
  onDialogChange?: (open: boolean) => void;
  readOnly?: boolean;
  compact?: boolean;
  useProjectSettings?: boolean;
  settingsRevision?: number;
}) {
  const [agents, setAgents] = useState<{
      agents: AgentAvailability[];
      writesEnabled: boolean;
    } | null>(null),
    [skills, setSkills] = useState<SkillMetadata[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [confirmation, setConfirmationState] = useState<{
      request: ProjectAgentStart;
      providerLabel: string;
    } | null>(null),
    [runState, setRunState] = useState<{
      repositoryId: string;
      run: AgentRun;
    } | null>(null),
    [log, setLog] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const run = runState?.repositoryId === repositoryId ? runState.run : null;
  const knownRuns = useRef(new Map<string, { run: AgentRun; log: string }>());
  const [knownRunsRevision, setKnownRunsRevision] = useState(0);
  const [dismissedRunIds, setDismissedRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  function rememberRun(value: AgentRun, output?: string, owner = repositoryId) {
    const previous = knownRuns.current.get(owner);
    const text = output ?? (previous?.run.id === value.id ? previous.log : "");
    knownRuns.current.delete(owner);
    knownRuns.current.set(owner, { run: value, log: text.slice(-65536) });
    // RegistrationStore permits at most 128 roots; retain every registered run handle.
    while (knownRuns.current.size > 128)
      knownRuns.current.delete(knownRuns.current.keys().next().value!);
  }
  function setRun(value: AgentRun | null) {
    if (value) rememberRun(value);
    setRunState(value ? { repositoryId, run: value } : null);
  }
  const attentionRun =
    run &&
    ["failed", "needs-attention", "interrupted"].includes(run.status) &&
    !dismissedRunIds.has(run.id)
      ? run
      : null;
  const attentionMessage =
    error ||
    attentionRun?.error ||
    (attentionRun ? `Agent ${attentionRun.status}` : "");
  function dismissAttention() {
    setError("");
    if (attentionRun)
      setDismissedRunIds((previous) => {
        const next = new Set(previous);
        next.add(attentionRun.id);
        while (next.size > 32) next.delete(next.values().next().value!);
        return next;
      });
  }
  function setConfirmation(
    value: { request: ProjectAgentStart; providerLabel: string } | null,
  ) {
    if (!value) preparation.current++;
    setConfirmationState(value);
  }
  const [selectionOpen, setSelectionOpen] = useState(false);
  useEffect(() => {
    onDialogChange?.(selectionOpen || !!confirmation);
  }, [selectionOpen, !!confirmation, onDialogChange]);
  useEffect(
    () => () => {
      onDialogChange?.(false);
    },
    [onDialogChange],
  );
  const [projectSettings, setProjectSettings] =
    useState<ProjectAgentSettingsResponse | null>(null);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const preparation = useRef(0);
  function closeSelection() {
    preparation.current++;
    setSelectionOpen(false);
    setBusy(false);
  }
  const [adapter, setAdapter] = useState<AgentAdapter>("codex");
  const sendButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0),
    runGeneration = useRef(0);
  const prefix = `/repositories/${encodeURIComponent(repositoryId)}`;
  useEffect(() => {
    const g = ++generation.current;
    setSelected([]);
    setSelectionOpen(false);
    setConfirmation(null);
    setSkills([]);
    setAgents(null);
    setProjectSettings(null);

    setError("");
    setBusy(false);
    void Promise.all([
      api<NonNullable<typeof agents>>("/agents"),
      useProjectSettings
        ? api<ProjectAgentSettingsResponse>(`${prefix}/project-settings`).then(
            async (saved) => ({
              saved,
              ...(await api<{ skills: SkillMetadata[] }>(
                `${prefix}/skills?reviewId=${encodeURIComponent(reviewId)}&startingFolder=${encodeURIComponent(saved.settings.startingFolder)}`,
              )),
            }),
          )
        : api<{ skills: SkillMetadata[] }>("/skills"),
    ])
      .then(([a, s]) => {
        if (g === generation.current) {
          setAgents(a);
          setSkills(s.skills || []);
          const saved = (
            "saved" in s ? s.saved : null
          ) as ProjectAgentSettingsResponse | null;
          if (saved) {
            setProjectSettings(saved);
            setAdapter(saved.settings.adapter);
          }
        }
      })
      .catch((e) => {
        if (g === generation.current) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [repositoryId, reviewId, useProjectSettings, settingsRevision]);
  useEffect(() => {
    runGeneration.current++;
    const known = knownRuns.current.get(repositoryId);
    // Running SSE replays the server log on return; clear its cached copy to avoid duplicates.
    if (known)
      rememberRun(known.run, known.run.status === "running" ? "" : known.log);
    setRun(known?.run ?? null);
    setLog(known?.run.status === "running" ? "" : (known?.log ?? ""));
    return () => {
      runGeneration.current++;
    };
  }, [repositoryId]);
  useEffect(() => {
    // A returned authorized launch updates only its owner's cache. Hydrate the
    // currently viewed repository from that cache, even after a round-trip navigation.
    const known = knownRuns.current.get(repositoryId);
    if (known && run?.id !== known.run.id) {
      if (known.run.status === "running") rememberRun(known.run, "");
      setRun(known.run);
      setLog(known.run.status === "running" ? "" : known.log);
    }
  }, [repositoryId, knownRunsRevision]);
  useEffect(
    () => setConfirmation(null),
    [
      profile?.revision,
      profile?.effective?.locator,
      profile?.effective?.digest,
    ],
  );
  const current = comments.filter(
    (c) => c.status === "open" && c.attachment === "current",
  );
  const effectiveSkill = useProjectSettings
    ? projectSettings?.settings.skill
    : profile?.effective;
  const exact = skills.some(
    (s) =>
      s.locator === effectiveSkill?.locator &&
      s.digest === effectiveSkill.digest,
  );
  const providerLabel =
    agents?.agents?.find((a) => a.id === adapter)?.provider?.label ||
    (adapter === "codex"
      ? unknownCodexProvider.label
      : `Provider identity unknown; uses local ${adapter} CLI settings`);
  const available =
    !readOnly &&
    agents?.writesEnabled &&
    agents.agents?.some((a) => a.id === adapter && a.available);
  useEffect(() => {
    if (!run || run.status !== "running" || typeof EventSource === "undefined")
      return;
    const g = runGeneration.current;
    const stream = new EventSource(
      `/api${prefix}/agents/${encodeURIComponent(run.id)}/events`,
    );
    stream.onmessage = (e) => {
      if (
        g !== runGeneration.current ||
        knownRuns.current.get(repositoryId)?.run.id !== run.id
      )
        return;
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        if (event.type === "output") {
          const text = (
            (knownRuns.current.get(repositoryId)?.log ?? "") + event.text
          ).slice(-65536);
          rememberRun(run, text);
          setLog(text);
        } else {
          if (event.run.id !== run.id) return;
          setRun(event.run);
          if (event.run.status !== "running") stream.close();
        }
      } catch {
        setError("Invalid agent event");
      }
    };
    stream.onerror = () => {
      if (
        g === runGeneration.current &&
        knownRuns.current.get(repositoryId)?.run.id === run.id
      )
        setError("Agent stream disconnected; retrying");
    };
    return () => stream.close();
  }, [run?.id, run?.status, prefix]);
  async function prepare() {
    const frozenProviderLabel = providerLabel;
    const p = ++preparation.current;
    const g = generation.current;
    setBusy(true);
    try {
      const exported = await api<ProjectAgentContext>(
        `${prefix}/${useProjectSettings ? "agent-context" : "export"}?reviewId=${encodeURIComponent(reviewId)}`,
      );
      if (
        useProjectSettings &&
        (!exported.execution ||
          exported.execution.adapter !== adapter ||
          exported.execution.settingsRevision !== projectSettings?.revision ||
          exported.execution.skill.locator !== effectiveSkill?.locator ||
          exported.execution.skill.digest !== effectiveSkill?.digest)
      )
        throw new Error(
          "Project agent settings changed; reload settings before sending",
        );
      if (g === generation.current && p === preparation.current) {
        setSelectionOpen(false);
        setConfirmation({
          providerLabel: frozenProviderLabel,
          request: {
            adapter,
            reviewId,
            commentIds: selected.filter((id) =>
              current.some((c) => c.id === id),
            ),
            expected: {
              target: exported.target,
              profile: exported.profile,
              ...(exported.execution ? { execution: exported.execution } : {}),
            },
          },
        });
      }
    } catch (e) {
      if (g === generation.current && p === preparation.current)
        setError((e as Error).message);
    } finally {
      if (g === generation.current && p === preparation.current) setBusy(false);
    }
  }
  async function send() {
    if (!confirmation) return;
    const g = runGeneration.current;
    const frozen = confirmation.request;
    setConfirmation(null);
    setBusy(true);
    try {
      const r = await api<AgentRun>(`${prefix}/agents`, "POST", frozen);
      rememberRun(r, "", repositoryId);
      setKnownRunsRevision((value) => value + 1);
      if (g === runGeneration.current) {
        setRun(r);
        setLog("");
      }
    } catch (e) {
      if (g === runGeneration.current) setError((e as Error).message);
    } finally {
      if (g === runGeneration.current) setBusy(false);
    }
  }
  async function stop() {
    if (!run) return;
    const g = runGeneration.current;
    try {
      const r = await api<AgentRun>(
        `${prefix}/agents/${encodeURIComponent(run.id)}/stop`,
        "POST",
      );
      if (g === runGeneration.current) setRun(r);
    } catch (e) {
      if (g === runGeneration.current) setError((e as Error).message);
    }
  }
  const confirmationDialog =
    confirmation &&
    createPortal(
      <Modal
        label="Confirm agent transmission"
        returnFocus={compact ? triggerButton : sendButton}
        onClose={() => setConfirmation(null)}
      >
        <h2>
          Send to{" "}
          {confirmation.request.adapter === "codex"
            ? "Codex"
            : confirmation.request.adapter === "claude"
              ? "Claude"
              : "OpenCode"}
        </h2>
        <p>
          {confirmation.request.adapter} · {confirmation.providerLabel} ·{" "}
          execution folder {confirmation.request.expected.target.worktreeRoot} ·
          skill folder{" "}
          {confirmation.request.expected.execution?.startingFolder ??
            confirmation.request.expected.target.worktreeRoot}{" "}
          · project {confirmation.request.expected.target.projectId} ·{" "}
          {confirmation.request.expected.target.worktree?.branch ??
            confirmation.request.expected.target.branch}{" "}
          · HEAD {confirmation.request.expected.target.head} · skill{" "}
          {confirmation.request.expected.execution?.skill.locator ??
            confirmation.request.expected.profile.effective?.locator}{" "}
          · SHA-256{" "}
          {confirmation.request.expected.execution?.skill.digest ??
            confirmation.request.expected.profile.effective?.digest}
        </p>
        <p>
          The installed agent may read and transmit this worktree to its
          configured provider.
        </p>
        <button onClick={() => void send()} disabled={busy}>
          Confirm Send
        </button>
        <button onClick={() => setConfirmation(null)}>Cancel</button>
      </Modal>,
      document.body,
    );
  const controls = (
    <section className="agent-panel" aria-label="Agent controls">
      <strong>Fix with agent</strong>
      <label>
        Adapter
        <select
          aria-label="Agent adapter"
          value={adapter}
          disabled={useProjectSettings || busy || run?.status === "running"}
          onChange={(e) => {
            setConfirmation(null);
            setAdapter(e.target.value as AgentAdapter);
          }}
        >
          {(
            agents?.agents ?? [
              {
                id: "codex",
                available: false,
                provider: unknownCodexProvider,
                version: null,
                error: null,
              },
            ]
          ).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id === "codex"
                ? "Codex"
                : a.id === "claude"
                  ? "Claude"
                  : "OpenCode"}{" "}
              ·{" "}
              {a.provider?.label ??
                (a.id === "codex"
                  ? unknownCodexProvider.label
                  : `Provider identity unknown; uses local ${a.id} CLI settings`)}
            </option>
          ))}
        </select>
      </label>
      <div className="effective-skill" aria-label="Effective fix skill">
        <small>Fix skill</small>
        <span title={effectiveSkill?.locator}>
          {effectiveSkill?.locator || "No skill configured"}
        </span>
        <small>
          {useProjectSettings
            ? `Project settings · revision ${projectSettings?.revision ?? 0}`
            : profile?.source
              ? `${profile.source} · revision ${profile.revision}`
              : "Choose a skill in Fix profiles"}
        </small>
        {onOpenProfiles && (
          <button
            disabled={busy || readOnly}
            onClick={() => {
              if (compact) closeSelection();
              onOpenProfiles();
            }}
          >
            {useProjectSettings ? "Edit agent settings" : "Edit fix profile"}
          </button>
        )}
      </div>
      {adapter === "opencode" && (
        <small>
          OpenCode sends the prompt in argv, visible in the local process list.
          Maximum prompt size: 64 KiB. The CLI may retain provider session data.
        </small>
      )}
      {adapter === "claude" && (
        <small>
          Claude uses manual permissions with permission prompts disabled.
          Denied edits require attention. Local CLI hooks and plugins may run.
        </small>
      )}
      {current.map((c) => (
        <label key={c.id}>
          <input
            type="checkbox"
            checked={selected.includes(c.id)}
            disabled={busy || run?.status === "running"}
            onChange={(e) => {
              setConfirmation(null);
              setSelected((ids) =>
                e.target.checked
                  ? [...ids, c.id]
                  : ids.filter((id) => id !== c.id),
              );
            }}
          />
          {c.body || c.id}
        </label>
      ))}
      {!available && (
        <small>
          {agents?.agents?.find((a) => a.id === adapter)?.error ||
            "Agent unavailable or writes disabled"}
        </small>
      )}
      {!exact && (
        <small>
          Configure an installed skill with the exact digest in{" "}
          {useProjectSettings ? "Project Settings" : "Fix profiles"}.
        </small>
      )}
      <button
        ref={sendButton}
        disabled={
          !available ||
          !exact ||
          !selected.some((id) => current.some((c) => c.id === id)) ||
          busy ||
          run?.status === "running"
        }
        onClick={() => void prepare()}
      >
        Send to agent
      </button>
      {run && (
        <>
          <p role="status">Agent {run.status}</p>
          {run.error && <p>{run.error}</p>}
          {run.status === "running" && (
            <button onClick={() => void stop()}>Stop agent</button>
          )}
        </>
      )}
      {log && <pre aria-label="Agent output">{log}</pre>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
  if (!compact)
    return (
      <>
        {controls}
        {confirmationDialog}
      </>
    );
  return (
    <>
      <button
        className="primary fix-agent-trigger"
        aria-label="Fix with Agent"
        ref={triggerButton}
        disabled={readOnly && run?.status !== "running"}
        onClick={() => {
          setSelectionOpen(true);
        }}
      >
        ✧ Fix with Agent{run?.status === "running" ? " · Running" : ""}
      </button>
      {selectionOpen &&
        createPortal(
          <Modal
            label="Fix with Agent"
            returnFocus={triggerButton}
            onClose={closeSelection}
          >
            <h2>Fix with Agent</h2>
            {controls}
          </Modal>,
          document.body,
        )}
      {confirmationDialog}
      {attentionMessage && !selectionOpen && !confirmation && (
        <div className="agent-launch-error" role="alert">
          <strong>
            {attentionRun
              ? `Agent ${attentionRun.status.replaceAll("-", " ")}`
              : "Agent needs attention"}
          </strong>
          <p>{attentionMessage}</p>
          <div>
            <button
              onClick={() => {
                setError("");
                setSelectionOpen(true);
              }}
            >
              {attentionRun ? "Review agent run" : "Review agent setup"}
            </button>
            <button
              aria-label={
                attentionRun ? "Dismiss agent run alert" : "Dismiss agent error"
              }
              onClick={dismissAttention}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
