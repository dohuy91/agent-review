import { createPortal } from "react-dom";
import Modal from "./Modal.js";
import {
  unknownCodexProvider,
  type AgentAvailability,
} from "../../../../packages/shared/src/index.js";
import React, { useEffect, useRef, useState } from "react";
import type {
  AttachedComment,
  ProfilesResponse,
  SkillMetadata,
  ReviewExport,
  AgentRun,
  AgentStart,
  AgentEvent,
  AgentAdapter,
} from "../../../../packages/shared/src/index.js";
import { api } from "../api.js";
export default function AgentPanel({
  repositoryId,
  reviewId,
  comments,
  profile,
  onProfile,
  onDialogChange,
  readOnly = false,
}: {
  repositoryId: string;
  reviewId: string;
  comments: AttachedComment[];
  profile: ProfilesResponse | null;
  onProfile: (p: ProfilesResponse) => void;
  onDialogChange?: (open: boolean) => void;
  readOnly?: boolean;
}) {
  const [agents, setAgents] = useState<{
      agents: AgentAvailability[];
      writesEnabled: boolean;
    } | null>(null),
    [skills, setSkills] = useState<SkillMetadata[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [confirmation, setConfirmationState] = useState<{
      request: AgentStart;
      providerLabel: string;
    } | null>(null),
    [run, setRun] = useState<AgentRun | null>(null),
    [log, setLog] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function setConfirmation(
    value: { request: AgentStart; providerLabel: string } | null,
  ) {
    setConfirmationState(value);
    onDialogChange?.(!!value);
  }
  const [adapter, setAdapter] = useState<AgentAdapter>("codex");
  const sendButton = useRef<HTMLButtonElement>(null);
  const generation = useRef(0),
    runGeneration = useRef(0);
  const prefix = `/repositories/${encodeURIComponent(repositoryId)}`;
  useEffect(() => {
    const g = ++generation.current;
    setSelected([]);
    setConfirmation(null);

    setError("");
    setBusy(false);
    void Promise.all([
      api<NonNullable<typeof agents>>("/agents"),
      api<{ skills: SkillMetadata[] }>("/skills"),
    ])
      .then(([a, s]) => {
        if (g === generation.current) {
          setAgents(a);
          setSkills(s.skills || []);
        }
      })
      .catch((e) => {
        if (g === generation.current) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [repositoryId, reviewId]);
  useEffect(() => {
    runGeneration.current++;
    setRun(null);
    setLog("");
    return () => {
      runGeneration.current++;
    };
  }, [repositoryId]);
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
  const exact = skills.some(
    (s) =>
      s.locator === profile?.effective?.locator &&
      s.digest === profile.effective.digest,
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
      if (g !== runGeneration.current) return;
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        if (event.type === "output")
          setLog((text) => (text + event.text).slice(-65536));
        else {
          setRun(event.run);
          if (event.run.status !== "running") stream.close();
        }
      } catch {
        setError("Invalid agent event");
      }
    };
    stream.onerror = () => {
      if (g === runGeneration.current)
        setError("Agent stream disconnected; retrying");
    };
    return () => stream.close();
  }, [run?.id, run?.status, prefix]);
  async function choose(locator: string) {
    const g = generation.current;
    setBusy(true);
    setConfirmation(null);
    try {
      const skill = skills.find((s) => s.locator === locator);
      if (!skill) return;
      const p = await api<ProfilesResponse>(`${prefix}/profiles`, "PUT", {
        reviewId,
        scope: "worktree",
        profile: { locator: skill.locator, digest: skill.digest },
      });
      if (g === generation.current) onProfile(p);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  async function prepare() {
    const frozenProviderLabel = providerLabel;
    const g = generation.current;
    setBusy(true);
    try {
      const exported = await api<ReviewExport>(
        `${prefix}/export?reviewId=${encodeURIComponent(reviewId)}`,
      );
      if (g === generation.current)
        setConfirmation({
          providerLabel: frozenProviderLabel,
          request: {
            adapter,
            reviewId,
            commentIds: selected.filter((id) =>
              current.some((c) => c.id === id),
            ),
            expected: { target: exported.target, profile: exported.profile },
          },
        });
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setBusy(false);
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
  return (
    <section className="agent-panel" aria-label="Agent controls">
      <strong>Fix with agent</strong>
      <label>
        Adapter
        <select
          aria-label="Agent adapter"
          value={adapter}
          disabled={busy || run?.status === "running"}
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
      <label>
        Installed skill
        <select
          aria-label="Installed skill"
          value={exact ? profile?.effective?.locator : ""}
          disabled={busy || readOnly}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">Select exact skill</option>
          {skills.map((s) => (
            <option key={s.locator} value={s.locator}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
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
      {!available && <small>Agent unavailable or writes disabled</small>}
      {!exact && (
        <small>Select an installed skill with the exact digest.</small>
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
      {confirmation &&
        createPortal(
          <Modal
            label="Confirm agent transmission"
            returnFocus={sendButton}
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
              {confirmation.request.expected.target.worktreeRoot} ·{" "}
              {confirmation.request.expected.target.branch} · HEAD{" "}
              {confirmation.request.expected.target.head} · skill{" "}
              {confirmation.request.expected.profile.effective?.locator}
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
        )}
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
}
