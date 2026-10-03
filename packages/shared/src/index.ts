export interface Repository {
    id: string;
    root: string;
    commonDir: string;
    gitDir: string;
    branch: string | null;
    head: string;
    projectId: string;
}
export interface RepositoriesResponse {
    repositories: Repository[];
    selectedRepositoryId: string | null;
    base: string | null;
    mode?: ReviewMode;
}
export interface APIError {
    error: string;
}
export type ReviewMode = 'branch' | 'working' | 'staged' | 'full';
export type FileKind = 'text' | 'binary' | 'symlink' | 'submodule' | 'conflict' | 'unsupported';
export interface ReviewFile {
    path: string;
    oldPath: string | null;
    status: string;
    kind: FileKind;
    fingerprint: string;
    oldOid: string | null;
    newOid: string | null;
    oldMode: string;
    newMode: string;
}
export interface ReviewObservation {
    historical?: boolean;
    id: string;
    repositoryId: string;
    fingerprint: string;
    base: string;
    mergeBase: string;
    head: string;
    branch: string | null;
    mode: ReviewMode;
    files: ReviewFile[];
}
export interface DiffLine {
    type: 'context' | 'add' | 'delete';
    text: string;
    oldLine: number | null;
    newLine: number | null;
}
export interface DiffHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
}
export interface FileDiff {
    reviewId: string;
    path: string;
    fingerprint: string;
    hunks: DiffHunk[];
    oldContent: string | null;
    newContent: string | null;
    unsupportedReason: string | null;
    contentFingerprint: string | null;
}
export interface BranchesResponse {
    branches: string[];
    current: string | null;
}

export type CommentSide = 'old' | 'new';
export type CommentSeverity = 'info' | 'warning' | 'error';
export type CommentStatus = 'open' | 'resolved';
export interface CommentInput { reviewId:string; path:string; side:CommentSide; startLine:number; endLine:number; body:string; severity:CommentSeverity }
export interface HashAnchor { version:1; selected:string[]; before:string[]; after:string[] }
export interface ReviewComment extends CommentInput {
 id:string; repositoryId:string; projectId:string; worktreeRoot:string;
 mode:ReviewMode; base:string; mergeBase:string; head:string; branch:string|null;
 reviewFingerprint:string; fileFingerprint:string; sourceOid:string|null; anchor:HashAnchor;
 status:CommentStatus; createdAt:string; updatedAt:string;
}
export interface AttachedComment extends ReviewComment {
 attachment:'current'|'outdated'; attachedRange:{startLine:number;endLine:number}|null;
 historicalContent:'available'|'unavailable'; attachedPath?:string|null;
}
export interface CommentsResponse { comments:AttachedComment[] }
export interface ReviewedResponse { files:{path:string;fingerprint:string;reviewed:boolean}[] }
export type ProfileScope='project'|'branch'|'worktree';
export interface SkillProfile { locator:string; digest:string }
export interface ProfilesResponse { effective:SkillProfile|null; source:ProfileScope|null; revision:number; profiles:Partial<Record<ProfileScope,SkillProfile>> }
export interface ReviewExport {
 schemaVersion:1; exportedAt:string;
 target:{repositoryId:string;projectId:string;worktreeRoot:string;gitDir:string;commonDir:string;branch:string|null;head:string;base:string;mergeBase:string;mode:ReviewMode;reviewFingerprint:string};
 comments:AttachedComment[]; profile:ProfilesResponse;
}

export interface SkillMetadata { locator:string;digest:string;name:string }
export type AgentStatus='running'|'completed'|'failed'|'stopped'|'interrupted'|'needs-attention';
export interface AgentRun { id:string;adapter:AgentAdapter;status:AgentStatus;target:ReviewExport['target'];profile:ProfilesResponse;commentIds:string[];createdAt:string;finishedAt:string|null;exitCode:number|null;error:string|null }
export interface AgentStart { adapter:AgentAdapter;reviewId:string;commentIds:string[];expected:{target:ReviewExport['target'];profile:ProfilesResponse} }

export type AgentEvent={type:'output';text:string}|{type:'status';run:AgentRun};

export interface AgentProviderMetadata {
  identity: string | null;
  label: string;
}
export interface AgentAvailability {
  id: string;
  available: boolean;
  version: string | null;
  error: string | null;
  provider?: AgentProviderMetadata;
}
export const unknownCodexProvider: AgentProviderMetadata = {
  identity: null,
  label: "Provider identity unknown; uses local Codex CLI settings",
};

export type AgentAdapter='codex'|'claude'|'opencode';
export interface ReviewHistoryEntry { id:string; repositoryId:string; fingerprint:string; base:string; mergeBase:string; head:string; branch:string|null; mode:ReviewMode; acceptedAt:string; fileCount:number; historicalContent:'git-objects-only'|'unavailable' }
export interface HistoryResponse { reviews:ReviewHistoryEntry[]; runs:AgentRun[] }
