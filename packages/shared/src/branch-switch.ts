export interface BranchSwitchPreviewRequest {
  reviewId: string;
  targetRef: string;
}
export interface BranchSwitchDirty {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}
export interface BranchSwitchPreview {
  previewId: string;
  expiresAt: string;
  repositoryId: string;
  reviewId: string;
  from: { branch: string; head: string };
  target: { branch: string; head: string };
  status: "clean" | "dirty" | "same-branch" | "occupied";
  dirty: BranchSwitchDirty;
  occupied?: {
    root: string;
    repositoryId?: string;
    branch: string;
    head: string;
  };
}
export interface BranchSwitchRequest {
  previewId: string;
  strategy: "clean" | "stash" | "commit";
  confirmed?: true;
  commit?: { paths: string[]; message: string };
}
export interface BranchSwitchStash {
  oid: string;
  sourceBranch: string;
  message: string;
}
export interface BranchSwitchResult {
  ok: true;
  outcome: "switched" | "same-branch";
  branch: string;
  head: string;
  stash?: BranchSwitchStash;
  commit?: string;
}
export interface BranchSwitchFailure {
  error: string;
  outcome: "not-switched" | "saved-not-switched" | "uncertain";
  reason:
    | "dirty"
    | "remaining-dirty"
    | "occupied"
    | "busy"
    | "stale"
    | "unsupported"
    | "git-refused";
  remainingDirty?: BranchSwitchDirty;
  actual?: { branch: string | null; head: string; dirty?: BranchSwitchDirty };
  stash?: BranchSwitchStash;
  commit?: string;
}
