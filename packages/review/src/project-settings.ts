import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Repository } from "../../shared/src/index.js";
import type {
  ProjectAgentSettings,
  ProjectAgentSettingsResponse,
} from "../../shared/src/project-settings.js";
import type { ReviewStore } from "./store.js";
import { invalid } from "./anchors.js";
import { gitText } from "../../git/src/git.js";
function table(store: ReviewStore) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS project_agent_settings(project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, metadata TEXT NOT NULL)",
  );
}
export function getProjectAgentSettings(
  store: ReviewStore,
  repository: Repository,
): ProjectAgentSettingsResponse {
  table(store);
  const row = store.db
    .prepare(
      "SELECT revision,metadata FROM project_agent_settings WHERE project_id=?",
    )
    .get(repository.projectId) as
    { revision: number; metadata: string } | undefined;
  return {
    projectId: repository.projectId,
    repositoryId: repository.id,
    revision: row?.revision ?? 0,
    settings: row
      ? JSON.parse(row.metadata)
      : { startingFolder: repository.root, adapter: "codex", skill: null },
  };
}
export function validateProjectAgentSettings(settings: ProjectAgentSettings) {
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    Object.keys(settings).some(
      (k) => !["startingFolder", "adapter", "skill"].includes(k),
    ) ||
    typeof settings.startingFolder !== "string" ||
    !settings.startingFolder ||
    settings.startingFolder.length > 4096 ||
    /[\x00-\x1f]/.test(settings.startingFolder) ||
    !["codex", "claude", "opencode"].includes(settings.adapter)
  )
    throw invalid();
  const skill = settings.skill;
  if (
    skill !== null &&
    (!skill ||
      typeof skill !== "object" ||
      Array.isArray(skill) ||
      Object.keys(skill).some((k) => !["locator", "digest"].includes(k)) ||
      typeof skill.locator !== "string" ||
      !skill.locator.trim() ||
      skill.locator.length > 2048 ||
      /[\x00-\x1f]/.test(skill.locator) ||
      typeof skill.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(skill.digest))
  )
    throw invalid();
}
export function putProjectAgentSettings(
  store: ReviewStore,
  repository: Repository,
  settings: ProjectAgentSettings,
  expectedRevision: number,
): ProjectAgentSettingsResponse {
  validateProjectAgentSettings(settings);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw invalid();
  table(store);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const current = getProjectAgentSettings(store, repository);
    if (current.revision !== expectedRevision)
      throw Object.assign(
        new Error("Project agent settings changed; reload before saving"),
        { statusCode: 409 },
      );
    store.db
      .prepare(
        "INSERT INTO project_agent_settings VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata",
      )
      .run(
        repository.projectId,
        current.revision + 1,
        JSON.stringify(settings),
      );
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return getProjectAgentSettings(store, repository);
}
export async function validateStartingFolder(
  repository: Repository,
  input: string,
): Promise<string> {
  const unavailable = () =>
    Object.assign(
      new Error(
        "Starting folder must be an existing canonical directory inside this review worktree",
      ),
      { statusCode: 409 },
    );
  try {
    if (
      typeof input !== "string" ||
      !isAbsolute(input) ||
      input.length > 4096 ||
      /[\x00-\x1f]/.test(input) ||
      input.split(/[\\/]/).some((part) => part === ".." || part === ".") ||
      resolve(input) !== input
    )
      throw unavailable();
    const rel = relative(repository.root, input);
    if (
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      (await realpath(repository.root)) !== repository.root ||
      (await realpath(input)) !== input ||
      !(await lstat(input)).isDirectory()
    )
      throw unavailable();
    // A nested repository is a different identity even when lexically contained.
    if (
      (await gitText(input, ["rev-parse", "--show-toplevel"])) !==
        repository.root ||
      (await gitText(input, ["rev-parse", "--absolute-git-dir"])) !==
        repository.gitDir
    )
      throw unavailable();
    return input;
  } catch {
    throw unavailable();
  }
}
