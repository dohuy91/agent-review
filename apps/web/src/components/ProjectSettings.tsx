import React, { useEffect, useRef, useState } from "react";
import type { Repository } from "../../../../packages/shared/src/index.js";
import type { SyncSettings } from "../../../../packages/shared/src/sync.js";
import type { ProjectAgentSettingsResponse } from "../../../../packages/shared/src/project-settings.js";
import type { ThemePreference } from "../preferences.js";
import { api } from "../api.js";
import AgentSettings from "./AgentSettings.js";
export type SettingsTab = "Project" | "Git" | "Agents" | "Appearance";
export default function ProjectSettings({
  repository,
  reviewId,
  comparisonRef,
  baseOptions,
  onComparison,
  defaultRemote,
  gitReady,
  remotes,
  initialTab = "Git",
  theme,
  onTheme,
  onSaved,
  onAgentSaved,
  onClose,
  onShortcuts,
  onProfiles,
}: {
  repository: Repository | undefined;
  reviewId: string;
  comparisonRef: string;
  baseOptions: string[];
  onComparison: (ref: string) => void;
  defaultRemote: string | null;
  gitReady: boolean;
  remotes: string[];
  initialTab?: SettingsTab;
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  onSaved: (remote: string | null) => void;
  onAgentSaved: (settings: ProjectAgentSettingsResponse) => void;
  onClose: () => void;
  onShortcuts: () => void;
  onProfiles: () => void;
}) {
  const [tab, setTab] = useState(initialTab),
    [remote, setRemote] = useState(defaultRemote || ""),
    [autoFetch, setAutoFetch] = useState(true),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const remoteEdited = useRef(false);
  useEffect(() => {
    if (!remoteEdited.current) setRemote(defaultRemote || "");
  }, [defaultRemote]);
  useEffect(() => {
    let alive = true;
    void api<SyncSettings>("/sync-settings")
      .then((value) => {
        if (alive) {
          setAutoFetch(value.autoFetchEnabled !== false);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function save() {
    if (!repository || busy || !loaded || !gitReady) return;
    setBusy(true);
    setError("");
    try {
      const [settings] = await Promise.all([
        api<{ defaultRemote: string | null }>(
          `/repositories/${encodeURIComponent(repository.id)}/git-settings`,
          "PUT",
          { defaultRemote: remote || null },
        ),
        api<SyncSettings>("/sync-settings", "PUT", {
          autoFetchEnabled: autoFetch,
        }),
      ]);
      onSaved(settings.defaultRemote);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const branch =
    repository?.branch?.replace(/^refs\/heads\//, "") || "Detached HEAD";
  return (
    <div className="project-settings">
      <h2>Settings</h2>
      <div className="settings-project">
        <strong>{repository?.root.split(/[\\/]/).at(-1) || "Project"}</strong>
        <span>Project settings</span>
      </div>
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {(["Project", "Git", "Agents", "Appearance"] as const).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={name === tab}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === "Project" && (
          <>
            <h3>Registered worktree</h3>
            <dl className="exact-target">
              <dt>Folder</dt>
              <dd>{repository?.root}</dd>
              <dt>Checked-out branch</dt>
              <dd>{branch}</dd>
            </dl>
            <p>
              Comparison and review drafts are kept separately for each project.
            </p>
            <button onClick={onShortcuts}>Keyboard shortcuts</button>
          </>
        )}
        {tab === "Git" && (
          <>
            <section>
              <h3>Repository defaults</h3>
              <label className="settings-row">
                Default remote
                <select
                  aria-label="Default remote"
                  value={remote}
                  onChange={(event) => {
                    remoteEdited.current = true;
                    setRemote(event.target.value);
                  }}
                  disabled={busy || !gitReady}
                >
                  <option value="">Choose a configured remote</option>
                  {remotes.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
            </section>
            <section>
              <label className="settings-switch">
                <span>
                  <strong>
                    Auto-fetch{" "}
                    <small className="settings-badge">App-wide</small>
                  </strong>
                  <p>Every 5 minutes while the app is running</p>
                  <small>
                    All available registered projects · all configured remotes
                    <br />
                    Fetch only. Local files are unchanged.
                  </small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Auto-fetch every 5 minutes"
                  checked={autoFetch}
                  disabled={!loaded || busy}
                  onChange={(event) => setAutoFetch(event.target.checked)}
                />
              </label>
            </section>
            <section>
              <h3>Pull behavior</h3>
              <strong>Merge comparison branch into local branch</strong>
              <p>
                {comparisonRef.replace(/^refs\/remotes\//, "")} → {branch}
                <br />
                Fetch first if the last fetch is older than 5 minutes.
                <br />
                Merge, not rebase. Dirty work is never auto-committed.
              </p>
            </section>
            <section>
              <h3>Push behavior</h3>
              <strong>
                Push → {remote || "(choose remote)"}/{branch}
              </strong>
              <p>The main button uses the same name as the local branch.</p>
              <div className="settings-comparison">
                <strong>⌄ Push to comparison branch</strong>
                <small>
                  Available from the Push arrow; confirm the destination.
                </small>
              </div>
              <p className="settings-safety">
                ♧ Non-force push only · Conflicts pause the merge
              </p>
            </section>
            <details className="settings-advanced-git">
              <summary>Advanced Git comparison</summary>
              <label>
                Base reference
                <input
                  aria-label="Base reference"
                  value={comparisonRef}
                  onChange={(event) => onComparison(event.target.value)}
                  list="base-branches"
                />
              </label>
              <datalist id="base-branches">
                {baseOptions.map((ref) => (
                  <option key={ref} value={ref} />
                ))}
              </datalist>
            </details>
          </>
        )}
        {tab === "Agents" && (
          <>
            <AgentSettings
              repositoryId={repository?.id || ""}
              reviewId={reviewId}
              onSaved={onAgentSaved}
            />
            <button className="settings-advanced" onClick={onProfiles}>
              Advanced fix profiles
            </button>
          </>
        )}
        {tab === "Appearance" && (
          <>
            <h3>Appearance</h3>
            <label>
              Theme
              <select
                aria-label="Theme"
                value={theme}
                onChange={(event) =>
                  onTheme(event.target.value as ThemePreference)
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <p>
              System follows your operating system’s appearance, including
              changes while the app is running.
            </p>
            <button onClick={onShortcuts}>Keyboard shortcuts</button>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="compose-actions">
        <button disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {tab !== "Agents" && (
          <button
            className="primary"
            disabled={busy || !loaded || !repository || !gitReady}
            onClick={() => void save()}
          >
            Save settings
          </button>
        )}
      </div>
    </div>
  );
}
