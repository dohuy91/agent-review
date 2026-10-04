import React, { useEffect, useRef, useState } from "react";
import type {
  AgentAdapter,
  AgentAvailability,
  SkillProfile,
} from "../../../../packages/shared/src/index.js";
import type {
  AgentFoldersResponse,
  ProjectAgentSettingsResponse,
  ProjectSkillMetadata,
  ProjectSkillsResponse,
} from "../../../../packages/shared/src/project-settings.js";
import { api } from "../api.js";
import "./AgentSettings.css";
export default function AgentSettings({
  repositoryId,
  reviewId,
  onSaved,
  readOnly = false,
}: {
  repositoryId: string;
  reviewId: string;
  onSaved?: (response: ProjectAgentSettingsResponse) => void;
  readOnly?: boolean;
}) {
  const [saved, setSaved] = useState<ProjectAgentSettingsResponse | null>(null);
  const [folder, setFolder] = useState("");
  const [adapter, setAdapter] = useState<AgentAdapter>("codex");
  const [skill, setSkill] = useState<SkillProfile | null>(null);
  const [skills, setSkills] = useState<ProjectSkillMetadata[]>([]);
  const [agents, setAgents] = useState<AgentAvailability[]>([]);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<AgentFoldersResponse | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [nativeChoosing, setNativeChoosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0),
    discovery = useRef(0),
    browsing = useRef(0);
  const prefix = `/repositories/${encodeURIComponent(repositoryId)}`;
  useEffect(() => {
    const g = ++generation.current;
    discovery.current++;
    browsing.current++;
    setSaved(null);
    setFolder("");
    setSkill(null);
    setSkills([]);
    setFolders(null);
    setChoosing(false);
    setNativeChoosing(false);
    setError("");
    setNotice("");
    setLoading(true);
    setBusy(false);
    void Promise.all([
      api<ProjectAgentSettingsResponse>(`${prefix}/project-settings`),
      api<{ agents: AgentAvailability[] }>("/agents"),
    ])
      .then(([settings, availability]) => {
        if (g !== generation.current) return;
        setSaved(settings);
        setFolder(settings.settings.startingFolder);
        setAdapter(settings.settings.adapter);
        setSkill(settings.settings.skill);
        setAgents(availability.agents || []);
      })
      .catch((e) => {
        if (g === generation.current) setError(e.message);
      })
      .finally(() => {
        if (g === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
      discovery.current++;
      browsing.current++;
    };
  }, [repositoryId, reviewId]);
  useEffect(() => {
    if (!folder || !saved) return;
    const g = generation.current,
      d = ++discovery.current;
    setSkills([]);
    setSkillsLoading(true);
    void api<ProjectSkillsResponse>(
      `${prefix}/skills?reviewId=${encodeURIComponent(reviewId)}&startingFolder=${encodeURIComponent(folder)}`,
    )
      .then((result) => {
        if (g === generation.current && d === discovery.current)
          setSkills(result.skills || []);
      })
      .catch((e) => {
        if (g === generation.current && d === discovery.current)
          setError(e.message);
      })
      .finally(() => {
        if (g === generation.current && d === discovery.current)
          setSkillsLoading(false);
      });
    return () => {
      discovery.current++;
    };
  }, [folder, saved?.revision, repositoryId, reviewId]);
  async function browse(path?: string) {
    const g = generation.current,
      b = ++browsing.current;
    setChoosing(true);
    setFolders(null);
    setError("");
    try {
      const result = await api<AgentFoldersResponse>(
        `${prefix}/agent-folders?reviewId=${encodeURIComponent(reviewId)}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
      );
      if (g === generation.current && b === browsing.current)
        setFolders(result);
    } catch (e) {
      if (g === generation.current && b === browsing.current)
        setError((e as Error).message);
    }
  }
  async function chooseNative() {
    const g = generation.current;
    setNativeChoosing(true);
    setError("");
    try {
      const result = await api<{ path: string | null }>(
        `${prefix}/agent-folder-picker`,
        "POST",
        { reviewId },
      );
      if (g === generation.current && result.path) {
        setFolder(result.path);
        setSkill(null);
        setNotice("");
      }
    } catch (error) {
      if (g === generation.current) setError((error as Error).message);
    } finally {
      if (g === generation.current) setNativeChoosing(false);
    }
  }
  async function save() {
    if (!saved || busy) return;
    const g = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<ProjectAgentSettingsResponse>(
        `${prefix}/project-settings`,
        "PUT",
        {
          reviewId,
          expectedRevision: saved.revision,
          settings: { startingFolder: folder, adapter, skill },
        },
      );
      if (g === generation.current) {
        setSaved(result);
        setNotice(
          "Skill folder, agent and exact skill are saved for this project.",
        );
        onSaved?.(result);
      }
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  const exact =
    !skill ||
    skills.some(
      (s) => s.locator === skill.locator && s.digest === skill.digest,
    );
  const matched = skills.filter((s) =>
    `${s.name} ${s.description || ""} ${s.source} ${s.sourceRoot}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="agent-settings" aria-label="Project agent settings">
      <label htmlFor="agent-starting-folder">Skill folder</label>
      <div className="agent-folder-control">
        <input
          id="agent-starting-folder"
          value={folder}
          readOnly
          placeholder="Loading project…"
        />
        <button
          onClick={() => void chooseNative()}
          disabled={loading || busy || readOnly || nativeChoosing}
        >
          {nativeChoosing ? "Choosing folder…" : "Choose folder…"}
        </button>
        <button
          onClick={() => void browse()}
          disabled={loading || busy || readOnly || nativeChoosing}
        >
          Browse project folder…
        </button>
      </div>
      <small>
        Project skills are discovered from this folder. The native chooser can
        select a different folder. Agents execute in the reviewed worktree.
      </small>
      {choosing && (
        <fieldset className="agent-folder-picker">
          <legend>Choose skill folder</legend>
          {folders ? (
            <>
              <p>{folders.path}</p>
              <div className="agent-folder-list">
                {folders.parent && (
                  <button onClick={() => void browse(folders.parent!)}>
                    Parent folder
                  </button>
                )}
                {folders.folders.map((f) => (
                  <button key={f.path} onClick={() => void browse(f.path)}>
                    {f.name}
                  </button>
                ))}
                {!folders.folders.length && <small>No subfolders</small>}
                {folders.truncated && (
                  <small>Folder list limited to 256 entries</small>
                )}
              </div>
              <button
                onClick={() => {
                  browsing.current++;
                  setFolder(folders.path);
                  setSkill(null);
                  setNotice("");
                  setChoosing(false);
                  setFolders(null);
                }}
              >
                Use this folder
              </button>
            </>
          ) : (
            <p role="status">Loading folders…</p>
          )}
          <button
            onClick={() => {
              browsing.current++;
              setChoosing(false);
              setFolders(null);
            }}
          >
            Cancel folder choice
          </button>
        </fieldset>
      )}
      <label className="agent-adapter-control">
        Agent
        <select
          aria-label="Agent"
          value={adapter}
          disabled={loading || busy || readOnly}
          onChange={(e) => {
            setAdapter(e.target.value as AgentAdapter);
            setNotice("");
          }}
        >
          {["codex", "claude", "opencode"].map((id) => (
            <option key={id} value={id}>
              {id === "codex"
                ? "Codex"
                : id === "claude"
                  ? "Claude"
                  : "OpenCode"}
              {agents.find((a) => a.id === id)?.available === false
                ? " · unavailable"
                : ""}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="agent-skill-search">Skill</label>
      <input
        id="agent-skill-search"
        aria-label="Search project and global skills"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search project and global skills…"
      />
      <div className="agent-skill-groups">
        {(["project", "global"] as const).map((source) => (
          <section
            key={source}
            aria-label={`${source === "project" ? "Project" : "Global"} skills`}
          >
            <div className="agent-skill-group-heading">
              <strong>
                {source === "project" ? "Project skills" : "Global skills"}
              </strong>
              <small>
                {[
                  ...new Set(
                    matched
                      .filter((s) => s.source === source)
                      .map((s) => s.sourceRoot),
                  ),
                ].join(" · ")}
              </small>
            </div>
            {matched
              .filter((s) => s.source === source)
              .map((s) => (
                <label
                  key={s.locator}
                  className={`agent-skill-option${skill?.locator === s.locator && skill.digest === s.digest ? " selected" : ""}`}
                  title={`${s.locator}\nSHA-256 ${s.digest}`}
                >
                  <input
                    type="radio"
                    name="project-agent-skill"
                    aria-label={`${s.name} ${s.source}`}
                    checked={
                      skill?.locator === s.locator && skill.digest === s.digest
                    }
                    disabled={busy || readOnly || skillsLoading}
                    onChange={() => {
                      setSkill({ locator: s.locator, digest: s.digest });
                      setNotice("");
                    }}
                  />
                  <span>{s.name}</span>
                  <small>{s.description || s.locator}</small>
                  <span className={`agent-skill-source ${source}`}>
                    {source === "project" ? "Project" : "Global"}
                  </span>
                </label>
              ))}
            {!matched.some((s) => s.source === source) && (
              <small className="agent-skills-empty">
                {skillsLoading ? "Discovering skills…" : "No matching skills"}
              </small>
            )}
          </section>
        ))}
      </div>
      <label className="agent-no-skill">
        <input
          type="radio"
          name="project-agent-skill"
          checked={!skill}
          disabled={busy || readOnly}
          onChange={() => {
            setSkill(null);
            setNotice("");
          }}
        />
        No skill selected
      </label>
      {!exact && (
        <p role="alert">
          The saved skill is unavailable or its digest changed. Choose the exact
          current skill before saving.
        </p>
      )}
      {notice && (
        <p role="status" className="agent-settings-saved">
          ✓ {notice}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="agent-settings-footer">
        <button
          className="primary"
          disabled={
            !saved ||
            loading ||
            skillsLoading ||
            busy ||
            readOnly ||
            !exact ||
            choosing ||
            nativeChoosing
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save for project"}
        </button>
      </div>
    </section>
  );
}
