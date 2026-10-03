import React, { useState } from "react";
import {
  defaultShortcuts,
  shortcutLabels,
  validateShortcuts,
  type ShortcutAction,
  type Shortcuts,
} from "../preferences.js";
export default function Preferences({
  shortcuts,
  onSave,
}: {
  shortcuts: Shortcuts;
  onSave: (value: Shortcuts) => void;
}) {
  const [draft, setDraft] = useState({ ...shortcuts }),
    [error, setError] = useState("");
  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <p>
        Use a single key or Escape. Leave Git action keys blank to keep them
        button-only. Commands leave typing alone and pause while a dialog is
        open.
      </p>
      {(Object.keys(shortcutLabels) as ShortcutAction[]).map((action) => (
        <label className="shortcut-setting" key={action}>
          {shortcutLabels[action]}
          <input
            aria-label={`${shortcutLabels[action]} shortcut`}
            value={draft[action]}
            maxLength={6}
            onChange={(e) =>
              setDraft((previous) => ({
                ...previous,
                [action]: e.target.value,
              }))
            }
          />
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="compose-actions">
        <button
          onClick={() => {
            setDraft({ ...defaultShortcuts });
            setError("");
          }}
        >
          Reset defaults
        </button>
        <button
          className="primary"
          onClick={() => {
            try {
              onSave(validateShortcuts(draft));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Save shortcuts
        </button>
      </div>
    </>
  );
}
