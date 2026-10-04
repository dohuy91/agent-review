import type {
  AgentAdapter,
  AgentRun,
  AgentStart,
  ReviewExport,
  SkillMetadata,
  SkillProfile,
} from "./index.js";
/** Skill discovery context; agent execution remains in the reviewed worktree. */
export interface ProjectAgentSettings {
  startingFolder: string;
  adapter: AgentAdapter;
  skill: SkillProfile | null;
}
export interface ProjectAgentSettingsResponse {
  projectId: string;
  repositoryId: string;
  revision: number;
  settings: ProjectAgentSettings;
}
export interface ProjectAgentSettingsRequest {
  reviewId: string;
  expectedRevision: number;
  settings: ProjectAgentSettings;
}
export interface ProjectSkillMetadata extends SkillMetadata {
  description?: string;
  source: "project" | "global";
  sourceRoot: string;
}
export interface ProjectSkillsResponse {
  startingFolder: string;
  skills: ProjectSkillMetadata[];
}
export interface AgentFoldersResponse {
  root: string;
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  truncated: boolean;
}
/** Exact explicit settings confirmation, independent of legacy profile precedence. */
export interface ProjectAgentExecution {
  startingFolder: string;
  folderStamp: string;
  settingsRevision: number;
  adapter: AgentAdapter;
  skill: SkillProfile;
}
export interface ProjectAgentContext extends ReviewExport {
  execution?: ProjectAgentExecution;
}
export interface ProjectAgentStart extends AgentStart {
  expected: AgentStart["expected"] & { execution?: ProjectAgentExecution };
}
export interface ProjectAgentRun extends AgentRun {
  execution?: ProjectAgentExecution;
}
