/** Guarded synchronization always operates on the actual checked-out branch. */
export interface SyncSettings {
  autoFetchEnabled: boolean;
  intervalMs: number;
}
export interface SyncRemoteStatus {
  name: string;
  eligible: boolean;
  reason: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
}
export interface MergeState {
  pending: boolean;
  mergeHeads: string[];
  conflicts: string[];
  canContinue: boolean;
  reason: string | null;
}
export interface RepositorySync {
  repositoryId: string;
  available: boolean;
  fetching: boolean;
  writesEnabled: boolean;
  autoFetchEnabled: boolean;
  actual: { branch: string | null; head: string } | null;
  remotes: SyncRemoteStatus[];
  merge: MergeState;
  error: string | null;
}
export interface PullPreviewRequest {
  comparisonRef: string;
}
export interface PullPreview {
  previewId: string;
  repositoryId: string;
  worktreeRoot: string;
  localBranch: string;
  localHead: string;
  comparisonRef: string;
  comparisonHead: string;
  remote: string;
  operation: "merge";
  expiresAt: string;
}
export interface SyncConfirmRequest {
  previewId: string;
  confirmed: true;
}
export interface MergePreviewRequest {
  action: "continue" | "abort";
}
export interface MergePreview {
  previewId: string;
  repositoryId: string;
  worktreeRoot: string;
  localBranch: string;
  localHead: string;
  mergeHeads: string[];
  conflicts: string[];
  action: "continue" | "abort";
  expiresAt: string;
}
export interface SyncMutationResult {
  ok: true;
  outcome: "merged" | "conflicts" | "continued" | "aborted";
  sync: RepositorySync;
}
export interface FetchAllResult {
  ok: boolean;
  sync: RepositorySync;
}
export interface GitSyncSettings {
  defaultRemote: string | null;
}
