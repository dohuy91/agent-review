import {
  defaultPaneWidths,
  sanitizePaneWidths,
  type PaneWidths,
} from "./paneLayout.js";

export const shortcutLabels = {
  nextFile: "Next file",
  previousFile: "Previous file",
  nextHunk: "Next hunk",
  previousHunk: "Previous hunk",
  comment: "Add comment",
  reviewed: "Toggle reviewed",
  close: "Close drawer or dialog",
  help: "Show shortcuts",
  stage: "Stage file",
  unstage: "Unstage file",
  discard: "Discard file",
  commit: "Commit selected",
  fetch: "Fetch selected remote",
} as const;
export type ShortcutAction = keyof typeof shortcutLabels;
export type Shortcuts = Record<ShortcutAction, string>;
export const defaultShortcuts: Shortcuts = {
  nextFile: "j",
  previousFile: "k",
  nextHunk: "n",
  previousHunk: "p",
  comment: "c",
  reviewed: "r",
  close: "Escape",
  help: "?",
  stage: "",
  unstage: "",
  discard: "",
  commit: "",
  fetch: "",
};
export type ThemePreference = "system" | "light" | "dark";
export interface Preferences {
  version: 1;
  shortcuts: Shortcuts;
  theme: ThemePreference;
  split: boolean;
  paneWidths: PaneWidths;
}
const key = "agent-review.preferences.v1";
export function validateShortcuts(value: unknown): Shortcuts {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((action) => !(action in shortcutLabels))
  )
    throw new Error("Invalid shortcut mapping");
  const result = {} as Shortcuts,
    assigned = new Map<string, string>();
  for (const action of Object.keys(shortcutLabels) as ShortcutAction[]) {
    const raw = (value as Record<string, unknown>)[action];
    if (
      typeof raw !== "string" ||
      (raw && raw !== "Escape" && !/^[\x21-\x7e]$/.test(raw))
    )
      throw new Error(
        "Use one printable key, Escape, or leave a Git action blank",
      );
    const shortcut = raw === "Escape" ? raw : raw.toLowerCase();
    if (!shortcut && ["close", "help"].includes(action))
      throw new Error("Close and help shortcuts are required");
    if (shortcut && assigned.has(shortcut))
      throw new Error(
        `Shortcut collision: ${shortcut} is already assigned to ${assigned.get(shortcut)}`,
      );
    if (shortcut) assigned.set(shortcut, shortcutLabels[action]);
    result[action] = shortcut;
  }
  return result;
}
export function loadPreferences(): Preferences {
  const defaults: Preferences = {
    version: 1,
    shortcuts: { ...defaultShortcuts },
    theme: "system",
    split: false,
    paneWidths: { ...defaultPaneWidths },
  };
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (!value || value.version !== 1 || typeof value.split !== "boolean")
      return defaults;
    return {
      version: 1,
      shortcuts: validateShortcuts(value.shortcuts),
      theme:
        value.theme === "system" ||
        value.theme === "light" ||
        value.theme === "dark"
          ? value.theme
          : value.theme === undefined && typeof value.dark === "boolean"
            ? value.dark
              ? "dark"
              : "light"
            : "system",
      split: value.split,
      paneWidths: sanitizePaneWidths(value.paneWidths),
    };
  } catch {
    return defaults;
  }
}
export function savePreferences(
  value: Omit<Preferences, "paneWidths"> & { paneWidths?: PaneWidths },
) {
  const valid = {
    ...value,
    version: 1,
    shortcuts: validateShortcuts(value.shortcuts),
    paneWidths: sanitizePaneWidths(
      value.paneWidths ?? loadPreferences().paneWidths,
    ),
  };
  localStorage.setItem(key, JSON.stringify(valid));
}
export function shortcutAction(
  event: KeyboardEvent,
  shortcuts: Shortcuts,
  modalOpen: boolean,
): ShortcutAction | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.repeat
  )
    return null;
  const pressed = event.key === "Escape" ? event.key : event.key.toLowerCase();
  if (pressed === "Escape" && (modalOpen || pressed === shortcuts.close))
    return "close";
  if (
    modalOpen ||
    (event.target instanceof Element &&
      event.target.closest(
        "input,textarea,select,[contenteditable],.cm-editor",
      ))
  )
    return null;
  return (
    (Object.keys(shortcuts) as ShortcutAction[]).find(
      (action) => shortcuts[action] && shortcuts[action] === pressed,
    ) ?? null
  );
}
