export interface PushPreviewRequest {
  reviewId: string;
  localRef: string;
  remote: string;
  destinationRef: string;
  comparisonRef?: string;
  inspectRemote: true;
}
export interface PushRecipient {
  url: string;
  transport: "https" | "ssh";
}
export interface PushPreview {
  previewId: string;
  expiresAt: string;
  repositoryId: string;
  reviewId: string;
  reviewFingerprint: string;
  localRef: string;
  sourceOid: string;
  worktree: { branch: string | null; head: string };
  remote: string;
  recipient: PushRecipient;
  destinationRef: string;
  comparisonRef?: string;
  destinationOid: string | null;
  newBranch: boolean;
  upToDate: boolean;
  outgoing: {
    total: number;
    commits: { oid: string; subject: string; committedAt: string }[];
    truncated: boolean;
  };
}
export interface PushResult {
  ok: true;
  outcome: "pushed" | "up-to-date";
  remote: string;
  recipient: PushRecipient;
  localRef: string;
  sourceOid: string;
  destinationRef: string;
}
export type PushFailureOutcome = "not-pushed" | "rejected" | "uncertain";

/** Offline, unambiguous inversion of a configured fetch refspec for a live tracking ref. */
export interface ComparisonPushDestination {
  trackingRef: string;
  remote: string;
  destinationRef: string;
}
export interface ComparisonPushDestinationsResponse {
  comparisonDestinations?: ComparisonPushDestination[];
}
